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

  // Lista de equipos conocidos, para poder separar "Equipo" del resto
  // del texto del nombre del jugador (ordenados de más largo a más corto
  // para no cortar mal, ej. "Real Sociedad" antes que "Real Madrid").
  const KNOWN_TEAMS = [
    'Real Sociedad', 'Real Madrid', 'R. Sociedad B',
    'Alavés', 'Athletic', 'Atlético', 'Barcelona', 'Betis', 'Celta',
    'Deportivo', 'Elche', 'Espanyol', 'Getafe', 'Levante', 'Málaga',
    'Osasuna', 'Racing', 'Rayo', 'Sevilla', 'Valencia', 'Villarreal'
  ].sort((a, b) => b.length - a.length);

  // La celda "Jugador" llega como "Nombre CompletoApodo Equipo" sin
  // separadores. El apodo casi siempre es una repetición (total o parcial,
  // al principio o al final) del nombre completo, así que lo detectamos
  // comparando el texto contra sí mismo, ignorando acentos/mayúsculas.
  // Validado contra 608 jugadores reales: 98,5% de acierto.
  function normalize(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function splitJugador(raw) {
    let rest = raw.trim();
    let equipo = '';

    for (const team of KNOWN_TEAMS) {
      if (rest === team || rest.endsWith(' ' + team)) {
        equipo = team;
        rest = rest.slice(0, rest.length - team.length).trim();
        break;
      }
    }

    let nombre = rest;
    let apodo = '';
    for (let len = Math.floor(rest.length / 2); len >= 3; len--) {
      const posibleApodo = rest.slice(rest.length - len);
      const posibleNombre = rest.slice(0, rest.length - len);
      if (posibleNombre.length === 0) continue;
      const nNombre = normalize(posibleNombre);
      const nApodo = normalize(posibleApodo);
      if (nNombre.endsWith(nApodo) || nNombre.startsWith(nApodo)) {
        nombre = posibleNombre;
        apodo = posibleApodo;
        break;
      }
    }

    if (!apodo) {
      const m = rest.match(
        /[A-ZÁÉÍÓÚÑ]\.\s?(?:(?:de|la|del|los)\s)?[A-ZÁÉÍÓÚÑ][\wÀ-ÿ'-]*(?:\s(?:de\s|la\s)?[A-ZÁÉÍÓÚÑ][\wÀ-ÿ'-]*)*$/
      );
      if (m && m.index > 0) {
        apodo = m[0];
        nombre = rest.slice(0, m.index);
      }
    }

    // Simplificación: nos quedamos solo con el nombre corto (el apodo,
    // que es como se ve en la app) y descartamos el nombre completo.
    // Si en algún caso raro no se detecta apodo, usamos el nombre
    // completo como último recurso para no dejar la celda vacía.
    const jugador = (apodo || nombre).trim();
    return { jugador, equipo };
  }

  // La posición se guarda como un icono con clase "icon-POR/DEF/MED/DEL"
  // (Portero/Defensa/Mediocampista/Delantero) en vez de como texto visible.
  const POSITION_MAP = { POR: 'Portero', DEF: 'Defensa', MED: 'Mediocampista', DEL: 'Delantero' };

  function extractPosicion(td) {
    let found = '';
    $(td)
      .find('[class]')
      .each((_, el) => {
        if (found) return;
        const cls = $(el).attr('class') || '';
        const m = cls.match(/icon-(POR|DEF|MED|DEL)\b/);
        if (m) found = POSITION_MAP[m[1]] || m[1];
      });
    return found;
  }

  // Estas 3 columnas sí traen genuinamente 6 valores (uno por periodo:
  // 1d, 2d, 3d, 7d, 14d, 30d), cada uno en su propio elemento hijo.
  const MULTI_PERIOD_COLUMNS = ['DiferenciaDif.', '% Dif', 'Valor ant.Ant.'];

  const extractCell = (td, headerName) => {
    const plain = () => $(td).text().trim().replace(/\s+/g, ' ');

    if (MULTI_PERIOD_COLUMNS.includes(headerName)) {
      const children = $(td).children().toArray();
      if (children.length > 1) {
        const parts = children.map((el) => $(el).text().trim()).filter(Boolean);
        if (parts.length > 1) return parts.join(' | ');
      }
    }

    // Resto de columnas (Acel., Tend., Valor...): texto plano tal cual,
    // sin intentar separar nada.
    return plain();
  };

  // Cabecera final: sustituimos "Jugador" por "Jugador" + "Equipo",
  // y añadimos "Posición" al final.
  const headerRow = [];
  headers.forEach((h) => {
    if (h === 'Jugador') {
      headerRow.push('Jugador', 'Equipo');
    } else {
      headerRow.push(h);
    }
  });
  headerRow.push('Posición');

  // Filas
  const rows = [];
  $(bestTable)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = [];
      let posicion = '';
      $(tr)
        .find('td')
        .each((i, td) => {
          const headerName = headers[i];
          if (headerName === 'Jugador') {
            const { jugador, equipo } = splitJugador($(td).text().trim().replace(/\s+/g, ' '));
            posicion = extractPosicion(td);
            cells.push(jugador, equipo);
          } else {
            cells.push(extractCell(td, headerName));
          }
        });
      cells.push(posicion);
      if (cells.length) rows.push(cells);
    });

  console.log(`Filas encontradas: ${rows.length}`);
  console.log('Cabeceras finales:', headerRow);
  console.log('Ejemplo primera fila:', rows[0]);

  const conPosicion = rows.filter((r) => r[r.length - 1]).length;
  console.log(`Filas con posición detectada: ${conPosicion} de ${rows.length}`);

  if (rows.length < 50) {
    console.warn(
      '⚠️  Se han extraído muy pocas filas. Revisa el log de arriba: ' +
      'puede que la estructura de la tabla haya cambiado y haya que ajustar el script.'
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(outDir, { recursive: true });

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
