import { fetchJSON, fmtScore, domainPill } from './utils.js';

const els = {
  siteTitle: document.getElementById('site-title'),
  navHome: document.getElementById('nav-home'),
  navTraj: document.getElementById('nav-trajectories'),
  navBreakdown: document.getElementById('nav-breakdown'),
  heroTitle: document.getElementById('hero-title'),
  heroSubtitle: document.getElementById('hero-subtitle'),
  pillars: document.getElementById('pillars'),
  scoreboardTitle: document.getElementById('scoreboard-title'),
  scoreboardSource: document.getElementById('scoreboard-source'),
  scoreboardLink: document.getElementById('scoreboard-link'),
  chartScoreTitle: document.getElementById('chart-score-title'),
  chartDomainTitle: document.getElementById('chart-domain-title'),
  howtoTitle: document.getElementById('howto-title'),
  howtoSteps: document.getElementById('howto-steps'),
  howtoFoot: document.getElementById('howto-foot'),
  footerText: document.getElementById('footer-text'),
  lbBody: document.getElementById('lb-body'),
  scoreChart: document.getElementById('scoreChart'),
  domainChart: document.getElementById('domainChart'),
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

  els.heroTitle.textContent = content.home.hero.title;
  els.heroSubtitle.textContent = content.home.hero.subtitle;

  els.pillars.innerHTML = content.home.hero.pillars.map(p => `
    <div class="p-4 bg-white rounded-lg shadow-sm border">
      <h3 class="font-semibold mb-1">${p.title}</h3>
      <p class="text-sm text-slate-600">${p.text}</p>
    </div>
  `).join('');

  els.scoreboardTitle.textContent = content.home.scoreboard.title;
  const domainsConfig = data.meta?.domainsConfig || '-';
  els.scoreboardSource.textContent = `${content.home.scoreboard.source} ${domainsConfig}`;
  els.scoreboardLink.textContent = content.home.scoreboard.link_text;
  els.scoreboardLink.href = content.home.scoreboard.link_href || './trajectories.html';

  els.chartScoreTitle.textContent = content.home.charts.final;
  els.chartDomainTitle.textContent = content.home.charts.bonus;

  els.howtoTitle.textContent = content.home.howto.title;
  els.howtoSteps.innerHTML = content.home.howto.steps.map(step => `<li>${step}</li>`).join('');
  els.howtoFoot.textContent = content.home.howto.footnote;
  els.footerText.textContent = content.home.footer;

  els.lbBody.innerHTML = runs.map(run => {
    const format = (value) => (value == null ? '-' : fmtScore(value));
    const domainSpread = (run.domains || []).map(d => `
      <span class="inline-flex items-center gap-1">${domainPill(d.name)}<span class="text-[10px] text-slate-500">×${d.unique}</span></span>
    `).join('<br/>') || '-';
    const manifestPath = run.runDir ? `${run.runDir.replace(/\/$/, '')}/unique_signatures.json` : null;
    const links = [];
    if (run.runId) {
      links.push(`<a class="underline" href="./trajectories.html#${run.runId}">Action log</a>`);
    }
    if (run.uniqueSignatures && manifestPath) {
      links.push(`<a class="underline" href="${manifestPath}" target="_blank" rel="noreferrer">Signatures</a>`);
    }
    return `
      <tr class="border-b last:border-0 align-top">
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

  const labels = runs.map(run => run.agent ?? run.model ?? '');
  const finalScores = runs.map(run => run.score?.final ?? 0);
  const baseScores = runs.map(run => run.score?.base ?? 0);
  const bonusScores = runs.map(run => run.score?.bonus ?? 0);
  const penaltyScores = runs.map(run => (run.score?.penalty ?? 0) * -1);

  new Chart(els.scoreChart, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Final',
          data: finalScores,
          backgroundColor: '#0f172a'
        },
        {
          label: 'Base',
          data: baseScores,
          backgroundColor: '#38bdf8'
        }
      ]
    },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true } }
    }
  });

  new Chart(els.domainChart, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Bonus',
        data: bonusScores,
        backgroundColor: '#f97316'
      }, {
        label: 'Penalty',
        data: penaltyScores,
        backgroundColor: '#dc2626'
      }]
    },
    options: {
      plugins: { legend: { position: 'bottom' } },
      scales: {
        y: { beginAtZero: true }
      }
    }
  });
}

main().catch(err => console.error(err));
