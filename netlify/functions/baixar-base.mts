export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const fonte = (url.searchParams.get('fonte') || 'SINAPI').toUpperCase();
    const uf = (url.searchParams.get('uf') || 'SC').toUpperCase();
    const mes = url.searchParams.get('mes') || '';
    const tipo = url.searchParams.get('tipo') || 'Nao desonerado';
    const origin = url.origin;

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

    if (base) {
      return Response.json({
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

    return Response.json({
      ok: false,
      modo: 'nao_encontrada',
      mensagem: 'Ainda nao ha arquivo automatico cadastrado para esta fonte/UF/mes. Use o portal oficial ou adicione o arquivo ao projeto.',
      parametros: { fonte, uf, mes, tipo },
      portalOficial: portals[fonte] || null
    }, { status: 404 });
  } catch (error) {
    return Response.json({ ok: false, erro: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
};
