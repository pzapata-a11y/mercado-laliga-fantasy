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

  // Filas
  const rows = [];
  $(bestTable)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = [];
      $(tr)
        .find('td')
        .each((_, td) => cells.push($(td).text().trim().replace(/\s+/g, ' ')));
      if (cells.length) rows.push(cells);
    });

  console.log(`Filas encontradas: ${rows.length}`);
  console.log('Cabeceras detectadas:', headers);
  console.log('Ejemplo primera fila:', rows[0]);

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
