import { fetchJSON, readFileAsText, parseJSONL, domainPill, signatureDomain, fmtScore } from './utils.js';

const els = {
  siteTitle: document.getElementById('site-title'),
  navHome: document.getElementById('nav-home'),
  navTraj: document.getElementById('nav-trajectories'),
  navBreakdown: document.getElementById('nav-breakdown'),
  title: document.getElementById('traj-title'),
  subtitle: document.getElementById('traj-subtitle'),
  loadSample: document.getElementById('load-sample'),
  or: document.getElementById('traj-or'),
  pickLabel: document.getElementById('traj-pick-label'),
  note: document.getElementById('traj-note'),
  pickRun: document.getElementById('pick-run'),
  txBody: document.getElementById('tx-body'),
  dlg: document.getElementById('dlg'),
  dlgContent: document.getElementById('dlg-content'),
  dlgTitle: document.getElementById('traj-detail-title'),
  dlgClose: document.getElementById('traj-close'),
  runInfo: document.getElementById('run-info'),
  meta: document.getElementById('meta'),
  select: document.getElementById('traj-select'),
  selectLabel: document.getElementById('traj-select-label')
};

let runOptions = [];

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

  els.title.textContent = content.trajectories.title;
  els.subtitle.textContent = content.trajectories.subtitle;
  els.loadSample.textContent = content.trajectories.uploader.sample_btn;
  els.or.textContent = content.trajectories.uploader.or;
  els.pickLabel.textContent = content.trajectories.uploader.pick_label;
  els.note.textContent = content.trajectories.uploader.note;
  els.dlgTitle.textContent = content.trajectories.detail_title;
  els.dlgClose.textContent = content.trajectories.close;
  els.selectLabel.textContent = content.trajectories.uploader.select_label;

  runOptions = runs.map(run => ({
    id: run.runId,
    path: run.runDir,
    rank: run.rank,
    model: run.agent ?? run.model ?? 'Unknown',
    score: run.score,
    capPerSignature: run.capPerSignature,
    windowMs: run.windowMs,
    notes: run.notes ?? null
  })).filter(opt => opt.id && opt.path);

  if (!runOptions.length) {
    els.select.innerHTML = '<option value="">No leaderboard runs found</option>';
  } else {
    els.select.innerHTML = runOptions.map(opt => `<option value="${opt.id}">#${opt.rank ?? '?'} · ${opt.model}</option>`).join('');
  }

  els.loadSample.addEventListener('click', async () => {
    const opt = runOptions.find(o => o.id === els.select.value);
    if (opt) {
      await loadFromHosted(opt);
      window.location.hash = opt.id;
    }
  });

  els.pickRun.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    const map = Object.fromEntries(files.map(f => [f.webkitRelativePath.split('/').pop(), f]));
    if (!map['eval_per_action.jsonl'] || !map['per_action.jsonl']) {
      alert(content.trajectories.errors?.missing_files || 'Missing required files.');
      return;
    }
    const evalText = await readFileAsText(map['eval_per_action.jsonl']);
    const actionText = await readFileAsText(map['per_action.jsonl']);
    const score = map['eval_score.json'] ? JSON.parse(await readFileAsText(map['eval_score.json'])) : null;
    const meta = map['run_meta.json'] ? JSON.parse(await readFileAsText(map['run_meta.json'])) : null;
    render(null, evalText, actionText, { score, meta });
    window.location.hash = '';
  });

  const initialHash = window.location.hash.replace('#', '');
  const initialOption = runOptions.find(opt => opt.id === initialHash) || runOptions[0] || null;
  if (initialOption) {
    els.select.value = initialOption.id;
    await loadFromHosted(initialOption);
    window.location.hash = initialOption.id;
  }
}

async function loadFromHosted(option) {
  if (!option) return;
  const base = option.path.replace(/\/$/, '');
  const [evalText, actionText] = await Promise.all([
    fetch(`${base}/eval_per_action.jsonl`).then(r => r.text()),
    fetch(`${base}/per_action.jsonl`).then(r => r.text())
  ]);
  const [score, meta] = await Promise.all([
    fetchJSON(`${base}/eval_score.json`).catch(() => option.score ? {
      finalScore: option.score.final,
      base: option.score.base,
      bonus: option.score.bonus,
      penalty: option.score.penalty,
      capPerSignature: option.capPerSignature,
      windowMs: option.windowMs
    } : null),
    fetchJSON(`${base}/run_meta.json`).catch(() => null)
  ]);
  render(option, evalText, actionText, { score, meta });
}

function render(option, evalText, actionText, extra = {}) {
  const summaries = parseJSONL(evalText);
  const actions = parseJSONL(actionText);
  const rawByStep = new Map(actions.map(entry => [entry.stepIdx ?? entry.step_idx, entry]));
  const { score, meta } = extra;

  if (option || score || meta) {
    const parts = [];
    if (option) {
      parts.push(`#${option.rank ?? '?'} · ${option.model}`);
    } else {
      parts.push('Uploaded run');
    }
    if (score) {
      if (score.final != null || score.finalScore != null) {
        const final = score.final != null ? score.final : score.finalScore;
        parts.push(`Final ${fmtScore(final)}`);
      }
      if (score.base != null) parts.push(`Base ${fmtScore(score.base)}`);
      if (score.bonus != null) parts.push(`Bonus ${fmtScore(score.bonus)}`);
      if (score.penalty != null) parts.push(`Penalty ${fmtScore(score.penalty)}`);
      if (score.capPerSignature != null || score.cap_per_signature != null) {
        const cap = score.capPerSignature != null ? score.capPerSignature : score.cap_per_signature;
        parts.push(`Cap per signature ${cap}`);
      }
      if (score.windowMs != null || score.window_ms != null) {
        const windowMs = score.windowMs != null ? score.windowMs : score.window_ms;
        parts.push(`Window ${windowMs} ms`);
      }
    } else {
      if (option?.capPerSignature) parts.push(`Cap per signature ${option.capPerSignature}`);
      if (option?.windowMs) parts.push(`Window ${option.windowMs} ms`);
    }
    if (meta?.benchVersion) parts.push(`Bench ${meta.benchVersion}`);
    if (meta?.builderCode) parts.push(`Builder ${meta.builderCode}`);
    if (option?.notes) parts.push(option.notes);
    els.meta.innerHTML = parts.join(' · ');
    els.runInfo.classList.remove('hidden');
  } else {
    els.runInfo.classList.add('hidden');
  }

  els.txBody.innerHTML = summaries.map(summary => {
    const step = summary.stepIdx ?? summary.step_idx;
    const signatures = summary.signatures || [];
    const domainNames = Array.from(new Set(signatures.map(signatureDomain).filter(Boolean)));
    const domainsHtml = domainNames.length
      ? domainNames.map(name => domainPill(name)).join(' ')
      : '-';
    const sigHtml = signatures.length
      ? signatures.map(sig => `<code>${sig}</code>`).join('<br/>')
      : '-';
    const windowKey = summary.windowKeyMs ?? summary.window_key_ms;
    const ignored = summary.ignored ? 'Yes' : 'No';
    const reason = summary.reason || '-';
    return `
      <tr class="border-b last:border-0 align-top">
        <td class="px-3 py-2 font-mono text-xs">${step}</td>
        <td class="px-3 py-2">${summary.action || '-'}</td>
        <td class="px-3 py-2 text-xs leading-5">${domainsHtml}</td>
        <td class="px-3 py-2 text-xs leading-5">${sigHtml}</td>
        <td class="px-3 py-2 text-right">${windowKey ?? '-'}</td>
        <td class="px-3 py-2">${ignored}</td>
        <td class="px-3 py-2 text-xs">${reason}</td>
        <td class="px-3 py-2 text-right">
          <button data-step="${step}" class="text-xs px-2 py-1 rounded border">Detail</button>
        </td>
      </tr>
    `;
  }).join('');

  els.txBody.querySelectorAll('button[data-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = Number(btn.getAttribute('data-step'));
      const summary = summaries.find(s => (s.stepIdx ?? s.step_idx) === step);
      const raw = rawByStep.get(step);
      const detail = {
        summary,
        raw,
        score,
        meta,
        leaderboard: option ? {
          id: option.id,
          rank: option.rank,
          model: option.model
        } : null
      };
      els.dlgContent.textContent = JSON.stringify(detail, null, 2);
      els.dlg.showModal();
    });
  });
}

main().catch(err => console.error(err));
