import { fetchJSON, fmtScore, domainPill } from './utils.js';

const els = {
  siteTitle: document.getElementById('site-title'),
  navHome: document.getElementById('nav-home'),
  navTraj: document.getElementById('nav-trajectories'),
  navBreakdown: document.getElementById('nav-breakdown'),
  title: document.getElementById('lc-title'),
  subtitle: document.getElementById('lc-subtitle'),
  knowledgeLabel: document.getElementById('lc-knowledge-label'),
  knowledgePath: document.getElementById('lc-knowledge-path'),
  knowledgeDesc: document.getElementById('lc-knowledge-desc'),
  knowledgeCta: document.getElementById('lc-knowledge-cta'),
  hianLabel: document.getElementById('lc-hian-label'),
  hianPath: document.getElementById('lc-hian-path'),
  hianDesc: document.getElementById('lc-hian-desc'),
  hianCta: document.getElementById('lc-hian-cta'),
  tableCaption: document.getElementById('lc-table-caption'),
  colRank: document.getElementById('lc-col-rank'),
  colModel: document.getElementById('lc-col-model'),
  colFinal: document.getElementById('lc-col-final'),
  colBase: document.getElementById('lc-col-base'),
  colBonus: document.getElementById('lc-col-bonus'),
  colPenalty: document.getElementById('lc-col-penalty'),
  colUnique: document.getElementById('lc-col-unique'),
  colDomains: document.getElementById('lc-col-domains'),
  colRuns: document.getElementById('lc-col-runs'),
  tbody: document.getElementById('lc-body'),
  notesTitle: document.getElementById('lc-notes-title'),
  notes: document.getElementById('lc-notes')
};

async function main() {
  const content = await fetchJSON('./data/content.json');
  const data = await fetchJSON('./data/models.json');
  const runs = [...(data.runs || [])].sort((a, b) => a.rank - b.rank);

  els.siteTitle.textContent = content.site.title;
  els.navHome.textContent = content.site.nav.home;
  els.navTraj.textContent = content.site.nav.trajectories;
  if (els.navBreakdown) {
    els.navBreakdown.textContent = content.site.nav.breakdown;
  }

  els.title.textContent = content.breakdown.title;
  els.subtitle.textContent = content.breakdown.subtitle;

  const policyPath = data.meta?.domainsConfig || '-';
  const topRun = runs[0];
  const manifestPath = topRun?.runDir ? `${topRun.runDir.replace(/\/$/, '')}/unique_signatures.json` : '-';

  els.knowledgeLabel.textContent = content.breakdown.datasets.policy.label;
  els.knowledgePath.textContent = policyPath;
  els.knowledgeDesc.textContent = content.breakdown.datasets.policy.description;
  els.knowledgeCta.textContent = content.breakdown.datasets.policy.cta;
  const policyHref = /^https?:/i.test(policyPath) ? policyPath : policyPath === '-' ? '#' : policyPath;
  els.knowledgeCta.href = policyHref;
  els.knowledgeCta.target = policyHref === '#' ? '_self' : '_blank';

  els.hianLabel.textContent = content.breakdown.datasets.signatures.label;
  els.hianPath.textContent = manifestPath;
  els.hianDesc.textContent = content.breakdown.datasets.signatures.description;
  els.hianCta.textContent = content.breakdown.datasets.signatures.cta;
  const manifestHref = manifestPath && manifestPath !== '-' ? manifestPath : '#';
  els.hianCta.href = manifestHref;
  els.hianCta.target = manifestHref === '#' ? '_self' : '_blank';

  els.tableCaption.textContent = content.breakdown.table.caption;
  els.colRank.textContent = content.breakdown.table.cols.rank;
  els.colModel.textContent = content.breakdown.table.cols.agent;
  els.colFinal.textContent = content.breakdown.table.cols.final;
  els.colBase.textContent = content.breakdown.table.cols.base;
  els.colBonus.textContent = content.breakdown.table.cols.bonus;
  els.colPenalty.textContent = content.breakdown.table.cols.penalty;
  els.colUnique.textContent = content.breakdown.table.cols.unique;
  els.colDomains.textContent = content.breakdown.table.cols.domains;
  els.colRuns.textContent = content.breakdown.table.cols.runs;

  els.tbody.innerHTML = runs.map(run => {
    const format = (value) => (value == null ? '-' : fmtScore(value));
    const domainSpread = (run.domains || []).map(d => `
      <span class="inline-flex items-center gap-1">${domainPill(d.name)}<span class="text-[10px] text-slate-500">×${d.unique}</span></span>
    `).join('<br/>') || '-';
    const runHref = run.runId ? `./trajectories.html#${run.runId}` : null;
    const manifest = run.runDir ? `${run.runDir.replace(/\/$/, '')}/unique_signatures.json` : null;
    const links = [];
    if (runHref) links.push(`<a class="underline" href="${runHref}">Action log</a>`);
    if (manifest) links.push(`<a class="underline" href="${manifest}" target="_blank" rel="noreferrer">Manifest</a>`);
    return `
      <tr class="border-b last:border-0">
        <td class="px-3 py-2">${run.rank ?? '-'}</td>
        <td class="px-3 py-2">${run.agent ?? run.model ?? '-'}</td>
        <td class="px-3 py-2 text-right font-mono">${format(run.score?.final)}</td>
        <td class="px-3 py-2 text-right font-mono">${format(run.score?.base)}</td>
        <td class="px-3 py-2 text-right font-mono">${format(run.score?.bonus)}</td>
        <td class="px-3 py-2 text-right font-mono">${format(run.score?.penalty)}</td>
        <td class="px-3 py-2 text-right">${run.uniqueSignatures ?? '-'}</td>
        <td class="px-3 py-2 text-xs leading-5">${domainSpread}</td>
        <td class="px-3 py-2 text-xs text-slate-700">${links.join(' · ') || '-'}</td>
      </tr>
    `;
  }).join('');

  els.notesTitle.textContent = content.breakdown.notes.title;
  els.notes.innerHTML = content.breakdown.notes.items.map(item => `<li>${item}</li>`).join('');
}

main().catch(err => console.error(err));
