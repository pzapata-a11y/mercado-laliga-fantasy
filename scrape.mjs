import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const URL = 'https://www.futbolfantasy.com/analytics/laliga-fantasy/mercado';

async function main() {
  const res = await fetch(URL, {
    headers: {
      // Un user-agent "normal" evita bloqueos básicos anti-bot
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });

  if (!res.ok) {
    throw new Error(`Error HTTP ${res.status} al descargar la página`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Estrategia robusta: en vez de depender de una clase CSS concreta
  // (que puede cambiar), buscamos la tabla con más filas de la página,
  // que casi seguro es la del mercado.
  let bestTable = null;
  let bestRowCount = 0;

  $('table').each((_, table) => {
    const rowCount = $(table).find('tbody tr').length;
    if (rowCount > bestRowCount) {
      bestRowCount = rowCount;
      bestTable = table;
    }
  });

  if (!bestTable) {
    throw new Error(
      'No se encontró ninguna tabla HTML en la página. Es posible que el sitio ' +
      'haya cambiado y ahora cargue los datos vía una llamada JS/API independiente. ' +
      'Revisa manualmente el HTML o el tráfico de red (pestaña Network del navegador).'
    );
  }

  // Cabeceras (si existen)
  const headers = [];
  $(bestTable)
    .find('thead th')
    .each((_, th) => headers.push($(th).text().trim().replace(/\s+/g, ' ')));

  // Algunas celdas contienen varios valores "apelmazados" internamente
  // (ej. nombre completo + apodo + equipo, o los 6 periodos temporales
  // de Diferencia/% Dif/Valor). En vez de adivinar el formato exacto,
  // si la celda tiene varios elementos hijos los separamos con " | "
  // para poder partirlos fácilmente después con SPLIT() en Sheets/Excel.
  const extractCell = (td) => {
    const children = $(td).children().toArray();
    if (children.length > 1) {
      const parts = children
        .map((el) => $(el).text().trim().replace(/\s+/g, ' '))
        .filter((t) => t.length > 0);
      if (parts.length > 1) return parts.join(' | ');
    }
    return $(td).text().trim().replace(/\s+/g, ' ');
  };

  // Filas
  const rows = [];
  $(bestTable)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find('td')
        .each((_, td) => cells.push(extractCell(td)));
      if (cells.length) rows.push(cells);
    });

  console.log(`Filas encontradas: ${rows.length}`);
  console.log('Cabeceras detectadas:', headers);
  console.log('Ejemplo primera fila:', rows[0]);

  // --- DEPURACIÓN TEMPORAL ---
  // Imprimimos el HTML crudo de la primera fila de datos para buscar
  // atributos ocultos (class, data-posicion, etc.) que no se ven como
  // texto pero que la web usa internamente para el filtro de posiciones.
  const firstRow = $(bestTable).find('tbody tr').first();
  console.log('--- HTML crudo de la primera fila (para buscar la posición) ---');
  console.log($.html(firstRow));
  console.log('--- fin HTML crudo ---');

  if (rows.length < 50) {
    console.warn(
      '⚠️  Se han extraído muy pocas filas. Revisa el log de arriba: ' +
      'puede que la estructura de la tabla haya cambiado y haya que ajustar el script.'
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });

  const headerRow = headers.length ? headers : rows[0].map((_, i) => `col${i + 1}`);
  const csvLines = [headerRow.map(csvEscape).join(',')];
  rows.forEach((r) => csvLines.push(r.map(csvEscape).join(',')));

  const outPath = path.join(outDir, `mercado_${today}.csv`);
  fs.writeFileSync(outPath, csvLines.join('\n'), 'utf-8');

  console.log(`Guardado: data/mercado_${today}.csv`);

  // --- Histórico acumulativo (una fila por jugador y día, con columna Fecha) ---
  // Este es el archivo pensado para conectar con Google Sheets vía IMPORTDATA,
  // ya que su URL nunca cambia y va creciendo cada día.
  const historicoPath = path.join(outDir, 'historico.csv');
  const historicoHeader = ['Fecha', ...headerRow];

  let previousBody = [];
  if (fs.existsSync(historicoPath)) {
    const existingLines = fs.readFileSync(historicoPath, 'utf-8').split('\n').filter(Boolean);
    previousBody = existingLines.slice(1); // todo menos la cabecera
    // Si se re-ejecuta el mismo día (ej. relanzas el workflow a mano),
    // quitamos las filas de hoy para no duplicar.
    const todayPrefix = csvEscape(today) + ',';
    previousBody = previousBody.filter((line) => !line.startsWith(todayPrefix));
  }

  const newBody = rows.map((r) => [today, ...r].map(csvEscape).join(','));
  const fullBody = [...previousBody, ...newBody];
  const historicoCsv = [historicoHeader.map(csvEscape).join(','), ...fullBody].join('\n');
  fs.writeFileSync(historicoPath, historicoCsv, 'utf-8');

  console.log(`Histórico completo actualizado: ${fullBody.length} filas totales en data/historico.csv`);

  // --- Versión "ventana móvil" para Google Sheets ---
  // Este archivo SOLO guarda los últimos N días, así su tamaño se mantiene
  // estable para siempre y Sheets no se ralentiza aunque pasen meses/años.
  // El histórico completo (sin recortar) sigue disponible en historico.csv.
  const DASHBOARD_WINDOW_DAYS = 90; // ajusta este número si quieres más o menos ventana

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - DASHBOARD_WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const dashboardBody = fullBody.filter((line) => {
    const fecha = line.split(',')[0].replace(/^"|"$/g, '');
    return fecha >= cutoffStr;
  });

  const dashboardPath = path.join(outDir, 'historico_dashboard.csv');
  const dashboardCsv = [historicoHeader.map(csvEscape).join(','), ...dashboardBody].join('\n');
  fs.writeFileSync(dashboardPath, dashboardCsv, 'utf-8');

  console.log(
    `Dashboard (últimos ${DASHBOARD_WINDOW_DAYS} días): ${dashboardBody.length} filas en data/historico_dashboard.csv`
  );
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

main().catch((err) => {
  console.error('Error en el scraping:', err);
  process.exit(1);
});
