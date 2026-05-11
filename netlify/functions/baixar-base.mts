const ORSE_ROOT = 'https://orse.cehop.se.gov.br';

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ccedil: 'ç', Ccedil: 'Ç', atilde: 'ã', Atilde: 'Ã', otilde: 'õ', Otilde: 'Õ',
    aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í',
    oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', acirc: 'â', Acirc: 'Â',
    ecirc: 'ê', Ecirc: 'Ê', ocirc: 'ô', Ocirc: 'Ô', agrave: 'à', Agrave: 'À'
  };
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}

function cleanHtml(value: string) {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function brNumber(value: string | number | undefined) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').replace(/R\$/g, '').replace(/\s/g, '');
  if (!s) return 0;
  const normalized = s.includes(',') && s.includes('.')
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function monthParams(month: string) {
  const now = new Date();
  const [year, m] = (month || '').split('-').map(Number);
  return {
    year: Number.isFinite(year) && year > 1900 ? year : now.getUTCFullYear(),
    month: Number.isFinite(m) && m >= 1 && m <= 12 ? m : now.getUTCMonth() + 1,
    order: 1
  };
}

function getSetCookie(headers: Headers) {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const cookies = anyHeaders.getSetCookie?.() || [];
  const single = headers.get('set-cookie');
  if (single) cookies.push(single);
  return cookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

async function fetchText(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': 'ORCC/1.0 (+https://orcc-sc.netlify.app)',
      'Accept': 'text/html,application/xhtml+xml',
      ...(init.headers || {})
    }
  });
  if (!res.ok) throw new Error(`ORSE respondeu ${res.status} em ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder('windows-1252').decode(bytes);
}

function cellsFromRow(rowHtml: string) {
  const cells = [...rowHtml.matchAll(/<td\b[^>]*class=["']?CorpoTabela["']?[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(m => cleanHtml(m[1]));
  return cells;
}

function parseServiceRows(html: string) {
  const rows: Array<{ code: string; description: string; unit: string; cost: number; detailUrl: string }> = [];
  const matches = [...html.matchAll(/<a\s+href="(composicao\.asp\?[^"]*serv_nr_codigo=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (let i = 0; i < matches.length; i += 4) {
    const first = matches[i];
    const second = matches[i + 1];
    const third = matches[i + 2];
    const fourth = matches[i + 3];
    if (!first || !second || !third || !fourth) continue;
    const code = cleanHtml(first[3]).replace(/\/.*$/, '').padStart(5, '0');
    const description = cleanHtml(second[3]);
    const unit = cleanHtml(third[3]);
    const cost = brNumber(cleanHtml(fourth[3]));
    if (!code || !description) continue;
    rows.push({ code, description, unit, cost, detailUrl: ORSE_ROOT + '/' + decodeHtml(first[1]).replace(/&amp;/g, '&') });
  }
  const seen = new Set<string>();
  return rows.filter(r => {
    const key = `${r.code}|${r.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function itemCategory(marker: string, description: string) {
  const m = marker.toUpperCase();
  const d = description.toUpperCase();
  if (m === 'E' || d.includes('EQUIPAMENTO')) return 'Equipamento';
  if (m === 'M') return 'Material';
  if (m === 'O' || d.includes('PEDREIRO') || d.includes('SERVENTE') || d.includes('HORISTA')) return 'Mão de obra';
  if (m === 'S') return 'Composição auxiliar';
  if (m === 'T') return 'Serviço';
  return 'Outro';
}

function parseCompositionDetail(html: string) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cellsFromRow(m[1])).filter(c => c.length >= 7);
  const items = rows.map(cells => ({
    marker: cells[0],
    code: cells[1].replace(/\/.*$/, '').trim(),
    description: cells[2],
    unit: cells[3],
    coefficient: brNumber(cells[4]),
    price: brNumber(cells[5]),
    total: brNumber(cells[6])
  })).filter(i => i.code && i.description && (i.coefficient || i.price || i.total));
  return items.map(i => ({
    ...i,
    category: itemCategory(i.marker, i.description),
    price: i.price || (i.coefficient ? i.total / i.coefficient : 0)
  }));
}

async function buscarOrse(url: URL, origin: string) {
  const uf = (url.searchParams.get('uf') || 'SE').toUpperCase();
  const mesBase = url.searchParams.get('mes') || '';
  const tipo = url.searchParams.get('tipo') || 'Referencial';
  const termo = (url.searchParams.get('termo') || '').trim();
  const maxPages = Math.max(1, Math.min(20, Number(url.searchParams.get('paginas') || 5) || 5));
  const maxServices = Math.max(1, Math.min(40, Number(url.searchParams.get('limite') || 25) || 25));
  const incluirItens = url.searchParams.get('itens') !== '0';
  const termoNormalizado = termo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!termoNormalizado || termoNormalizado === 'orse' || termoNormalizado.length < 3) {
    return json({
      ok: false,
      modo: 'termo_invalido',
      mensagem: 'Para ORSE, informe uma palavra do serviço/composição. Não use apenas ORSE. Exemplos: concreto, pintura, telha, piso, argamassa.',
      parametros: { fonte: 'ORSE', uf, mes: mesBase, tipo }
    }, 400);
  }
  const { year, month, order } = monthParams(mesBase);
  const periodo = `${year}-${month}-${order}`;

  const form = new URLSearchParams({
    sltFonte: 'ORSE',
    sltPeriodo: periodo,
    sltGrupoServico: '0',
    rdbCriterio: termo ? '2' : '1',
    txtDescricao: termo,
    Submit: 'Consultar'
  });

  const firstRes = await fetch(`${ORSE_ROOT}/servicosargumento.asp?tarefa=consultar`, {
    method: 'POST',
    body: form,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ORCC/1.0 (+https://orcc-sc.netlify.app)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!firstRes.ok) throw new Error(`ORSE respondeu ${firstRes.status} na busca de serviços.`);
  const cookie = getSetCookie(firstRes.headers);
  const firstHtml = new TextDecoder('windows-1252').decode(new Uint8Array(await firstRes.arrayBuffer()));

  const serviceMap = new Map<string, ReturnType<typeof parseServiceRows>[number]>();
  parseServiceRows(firstHtml).forEach(s => serviceMap.set(`${s.code}|${s.description}`, s));

  for (let page = 2; page <= maxPages; page++) {
    try {
      const pageHtml = await fetchText(`${ORSE_ROOT}/servicosargumento.asp?tarefa=consultar&page=${page}`, {
        headers: cookie ? { Cookie: cookie } : {}
      });
      const services = parseServiceRows(pageHtml);
      if (!services.length) break;
      services.forEach(s => serviceMap.set(`${s.code}|${s.description}`, s));
    } catch {
      break;
    }
  }

  const allServices = [...serviceMap.values()];
  const services = allServices.slice(0, maxServices);
  const rows = [['codigo', 'descricao', 'unidade', 'custo', 'insumo_codigo', 'insumo_descricao', 'insumo_unidade', 'coeficiente', 'preco_unitario', 'categoria']];
  let detailCount = 0;
  for (const service of services) {
    if (!incluirItens) {
      rows.push([service.code, service.description, service.unit, String(service.cost), '', '', '', '', '', '']);
      continue;
    }
    let items: ReturnType<typeof parseCompositionDetail> = [];
    try {
      const detail = await fetchText(service.detailUrl, { headers: cookie ? { Cookie: cookie } : {} });
      items = parseCompositionDetail(detail);
    } catch {
      items = [];
    }
    if (items.length) {
      detailCount++;
      items.forEach(item => rows.push([
        service.code,
        service.description,
        service.unit,
        String(service.cost),
        item.code,
        item.description,
        item.unit,
        String(item.coefficient),
        String(item.price),
        item.category
      ]));
    } else {
      rows.push([service.code, service.description, service.unit, String(service.cost), '', '', '', '', '', '']);
    }
  }

  const normalizedMonth = `${year}-${String(month).padStart(2, '0')}`;
  return json({
    ok: true,
    modo: 'orse_html',
    mensagem: 'Dados ORSE obtidos no site oficial e normalizados para importação.',
    parametros: { fonte: 'ORSE', uf, mes: normalizedMonth, tipo },
    fileName: `ORSE_${uf}_${normalizedMonth}_${termo || 'consulta'}.csv`,
    rows,
    observacao: `Importadas ${services.length} composições da consulta ORSE. ${detailCount} vieram com itens analíticos. Termo: ${termo}. ${allServices.length > services.length ? `Foram encontrados mais resultados; refine o termo ou repita a busca. Limite desta busca: ${maxServices}.` : ''}`,
    portalOficial: `${origin}/`
  });
}

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const fonte = (url.searchParams.get('fonte') || 'SINAPI').toUpperCase();
    const uf = (url.searchParams.get('uf') || 'SC').toUpperCase();
    const mes = url.searchParams.get('mes') || '';
    const tipo = url.searchParams.get('tipo') || 'Nao desonerado';
    const origin = url.origin;

    if (fonte === 'ORSE') return await buscarOrse(url, origin);

    const bases: Record<string, { fileName: string; path: string; observacao: string }> = {
      'SICRO|SC|2026-01': {
        fileName: 'SC 01-2026 Relatorio Analitico de Composicoes de Custos.xlsx',
        path: '/sc-01-2026/SC%2001-2026%20Relat%C3%B3rio%20Anal%C3%ADtico%20de%20Composi%C3%A7%C3%B5es%20de%20Custos.xlsx',
        observacao: 'Base SICRO SC 01/2026 disponivel no projeto.'
      },
      'SINAPI|SC|2026-03': {
        fileName: 'SINAPI_Referencia_2026_03.xlsx',
        path: '/SINAPI_Refer%C3%AAncia_2026_03.xlsx',
        observacao: 'Base SINAPI SC 03/2026 disponivel no projeto.'
      }
    };

    const base = bases[`${fonte}|${uf}|${mes}`];

    if (fonte === 'SINAPI' && uf === 'SC' && mes === '2026-03') {
      return json({
        ok: true,
        modo: 'sinapi_pacote',
        mensagem: 'Pacote SINAPI encontrado. O app vai baixar ISD, CSD e Analitico para montar a base completa.',
        parametros: { fonte, uf, mes, tipo },
        fileName: 'SINAPI SC 2026-03 pacote completo',
        arquivos: [
          {
            tipo: 'isd',
            fileName: 'SINAPI_SC_ISD_2026_03.csv',
            downloadUrl: origin + '/SINAPI_SC_ISD_2026_03.csv'
          },
          {
            tipo: 'csd',
            fileName: 'SINAPI_SC_CSD_2026_03.csv',
            downloadUrl: origin + '/SINAPI_SC_CSD_2026_03.csv'
          },
          {
            tipo: 'analitico',
            fileName: 'SINAPI_Referencia_2026_03.xlsx',
            downloadUrl: origin + '/SINAPI_Refer%C3%AAncia_2026_03.xlsx'
          }
        ],
        observacao: 'SINAPI sera importado como base completa: insumos, composicoes sinteticas e itens analiticos.'
      });
    }

    if (base) {
      return json({
        ok: true,
        modo: 'arquivo_disponivel',
        mensagem: 'Base encontrada. O app pode baixar e importar automaticamente.',
        parametros: { fonte, uf, mes, tipo },
        fileName: base.fileName,
        downloadUrl: origin + base.path,
        observacao: base.observacao
      });
    }

    const portals: Record<string, string> = {
      SINAPI: 'https://www.caixa.gov.br/poder-publico/modernizacao-gestao/sinapi/Paginas/default.aspx',
      SICRO: 'https://www.gov.br/dnit/pt-br/assuntos/planejamento-e-pesquisa/custos-referenciais/sistemas-de-custos/sicro',
      ORSE: 'https://orse.cehop.se.gov.br/',
      SEINFRA: 'https://www.seinfra.ce.gov.br/'
    };

    return json({
      ok: false,
      modo: 'nao_encontrada',
      mensagem: 'Ainda nao ha arquivo automatico cadastrado para esta fonte/UF/mes. Use o portal oficial ou adicione o arquivo ao projeto.',
      parametros: { fonte, uf, mes, tipo },
      portalOficial: portals[fonte] || null
    }, 404);
  } catch (error) {
    return json({ ok: false, erro: error instanceof Error ? error.message : String(error) }, 500);
  }
};
