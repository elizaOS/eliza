// Renders benchmark registry results for local suite inspection.
const state = {
  data: null,
  sortBy: "started_at",
  sortOrder: "desc",
  benchmark: "",
  status: "",
  search: "",
  activeTab: "overview",
  diffGroups: [],
  diffSelection: null,
  diffPayload: null,
  playbackRuns: [],
  playbackSelection: null,
  playbackPayload: null,
  playbackHarness: "",
  playbackStepIndex: 0,
};

const HARNESS_ORDER = ["eliza", "openclaw", "hermes", "smithers", "random_v1"];

const numericKeys = new Set([
  "score",
  "high_score_value",
  "delta_to_high_score",
  "duration_seconds",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_tokens",
  "llm_call_count",
  "call_count",
]);

function textValue(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function compareValues(a, b, key, order) {
  const direction = order === "asc" ? 1 : -1;
  if (numericKeys.has(key)) {
    const av = Number(a[key] ?? Number.NEGATIVE_INFINITY);
    const bv = Number(b[key] ?? Number.NEGATIVE_INFINITY);
    return av === bv ? 0 : av > bv ? direction : -direction;
  }
  if (key === "started_at") {
    const at = Date.parse(textValue(a[key]));
    const bt = Date.parse(textValue(b[key]));
    return at === bt ? 0 : at > bt ? direction : -direction;
  }
  const av = textValue(a[key]).toLowerCase();
  const bv = textValue(b[key]).toLowerCase();
  if (av === bv) return 0;
  return av > bv ? direction : -direction;
}

function setGeneratedAt(data) {
  const el = document.getElementById("generated-at");
  const generatedAt = data.generated_at
    ? new Date(data.generated_at).toLocaleString()
    : "n/a";
  el.textContent = `Generated at ${generatedAt}`;
}

function renderCards(data, filteredRuns) {
  const cards = document.getElementById("summary-cards");
  const runs = data.runs || [];
  const succeeded = runs.filter((r) => r.status === "succeeded").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const latest = runs[0] || null;
  const items = [
    { k: "Total Runs", v: runs.length },
    { k: "Filtered Runs", v: filteredRuns.length },
    { k: "Succeeded", v: succeeded },
    { k: "Failed", v: failed },
    { k: "Benchmarks", v: (data.benchmark_summary || []).length },
    { k: "Latest Run", v: latest ? latest.run_id : "n/a" },
  ];
  cards.innerHTML = items
    .map(
      (it) =>
        `<article class="card"><div class="k">${it.k}</div><div class="v">${it.v}</div></article>`,
    )
    .join("");
}

function populateFilters(data) {
  const runs = data.runs || [];
  const benchmarks = [
    ...new Set(runs.map((r) => textValue(r.benchmark_id)).filter(Boolean)),
  ].sort();
  const statuses = [
    ...new Set(runs.map((r) => textValue(r.status)).filter(Boolean)),
  ].sort();

  const benchSelect = document.getElementById("filter-benchmark");
  const statusSelect = document.getElementById("filter-status");

  benchSelect.innerHTML = `<option value="">all</option>${benchmarks
    .map((v) => `<option value="${v}">${v}</option>`)
    .join("")}`;
  statusSelect.innerHTML = `<option value="">all</option>${statuses
    .map((v) => `<option value="${v}">${v}</option>`)
    .join("")}`;
}

function getFilteredRuns() {
  if (!state.data) return [];
  const search = state.search.trim().toLowerCase();
  let runs = [...(state.data.runs || [])];
  if (state.benchmark)
    runs = runs.filter((r) => textValue(r.benchmark_id) === state.benchmark);
  if (state.status)
    runs = runs.filter((r) => textValue(r.status) === state.status);
  if (search) {
    runs = runs.filter((r) => {
      const hay = [
        r.run_id,
        r.run_group_id,
        r.benchmark_id,
        r.agent,
        r.provider,
        r.model,
        r.status,
      ]
        .map(textValue)
        .join(" ")
        .toLowerCase();
      return hay.includes(search);
    });
  }
  runs.sort((a, b) => {
    const primary = compareValues(a, b, state.sortBy, state.sortOrder);
    if (primary !== 0) return primary;
    return compareValues(a, b, "run_id", state.sortOrder);
  });
  return runs;
}

function renderRunsTable(runs) {
  const body = document.getElementById("runs-body");
  body.innerHTML = runs
    .map((row) => {
      const statusClass = `status-${textValue(row.status)}`;
      return `<tr>
        <td>${textValue(row.run_id)}</td>
        <td>${textValue(row.run_group_id)}</td>
        <td>${textValue(row.benchmark_id)}</td>
        <td class="${statusClass}">${textValue(row.status)}</td>
        <td>${textValue(row.agent)}</td>
        <td>${textValue(row.provider)}</td>
        <td>${textValue(row.model)}</td>
        <td>${row.score ?? ""}</td>
        <td>${row.input_tokens ?? ""}</td>
        <td>${row.output_tokens ?? ""}</td>
        <td>${row.total_tokens ?? ""}</td>
        <td>${row.cached_tokens ?? ""}</td>
        <td>${row.call_count ?? row.llm_call_count ?? ""}</td>
        <td>${row.high_score_value ?? ""}</td>
        <td>${row.delta_to_high_score ?? ""}</td>
        <td>${textValue(row.started_at)}</td>
        <td>${row.duration_seconds ?? ""}</td>
      </tr>`;
    })
    .join("");
}

function renderLatestScores(data) {
  const latest = data.latest_scores || [];
  const body = document.getElementById("latest-body");
  body.innerHTML = latest
    .map(
      (row) => `<tr>
      <td>${textValue(row.benchmark_id)}</td>
      <td>${textValue(row.run_id)}</td>
      <td>${textValue(row.agent)}</td>
      <td>${textValue(row.provider)}</td>
      <td>${textValue(row.model)}</td>
      <td>${row.score ?? ""}</td>
      <td>${row.input_tokens ?? ""}</td>
      <td>${row.output_tokens ?? ""}</td>
      <td>${row.total_tokens ?? ""}</td>
      <td>${row.cached_tokens ?? ""}</td>
      <td>${row.call_count ?? row.llm_call_count ?? ""}</td>
      <td>${row.high_score_value ?? ""}</td>
      <td>${row.delta_to_high_score ?? ""}</td>
    </tr>`,
    )
    .join("");
}

function render() {
  if (!state.data) return;
  const runs = getFilteredRuns();
  renderCards(state.data, runs);
  renderRunsTable(runs);
  renderLatestScores(state.data);
  computeDiffGroups();
  renderDiffGroups();
  computePlaybackRuns();
  renderPlaybackRuns();
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function computeDiffGroups() {
  if (!state.data) {
    state.diffGroups = [];
    return;
  }
  const runs = state.data.runs || [];
  const grouped = new Map();
  for (const row of runs) {
    if (row.status !== "succeeded") continue;
    if (canonicalEntryCount(row) <= 0) continue;
    const harness = textValue(row.agent);
    if (!HARNESS_ORDER.includes(harness)) continue;
    const key = `${row.run_group_id}::${row.benchmark_id}`;
    const existing = grouped.get(key) || {
      run_group_id: row.run_group_id,
      benchmark_id: row.benchmark_id,
      task_id: row.run_id,
      task_ids: {},
      harnesses: new Set(),
      started_at: row.started_at,
    };
    existing.harnesses.add(harness);
    existing.task_ids[harness] = row.run_id;
    if (compareValues(row, existing, "started_at", "desc") < 0) {
      existing.started_at = row.started_at;
      existing.task_id = row.run_id;
    }
    grouped.set(key, existing);
  }
  // Surface random_v1 as a passive participant by joining on benchmark id.
  const randomByBenchmark = new Set();
  for (const row of runs) {
    if (row.status !== "succeeded") continue;
    if (textValue(row.agent) !== "random_v1") continue;
    if (canonicalEntryCount(row) > 0) {
      randomByBenchmark.add(row.benchmark_id);
    }
  }
  const result = [];
  for (const group of grouped.values()) {
    if (randomByBenchmark.has(group.benchmark_id)) {
      group.harnesses.add("random_v1");
    }
    if (group.harnesses.size < 2) continue;
    result.push({
      ...group,
      harnesses: [...group.harnesses].sort(
        (a, b) => HARNESS_ORDER.indexOf(a) - HARNESS_ORDER.indexOf(b),
      ),
    });
  }
  result.sort((a, b) =>
    textValue(b.started_at).localeCompare(textValue(a.started_at)),
  );
  state.diffGroups = result;
}

function canonicalEntryCount(row) {
  const count = Number(
    row?.metrics?.canonical_entries ?? row?.canonical_entries ?? 0,
  );
  return Number.isFinite(count) ? count : 0;
}

function renderDiffGroups() {
  const body = document.getElementById("diff-groups-body");
  if (!body) return;
  const groups = state.diffGroups;
  if (!groups.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No multi-harness groups with canonical trajectories yet.</td></tr>`;
    return;
  }
  body.innerHTML = groups
    .map(
      (g) => `<tr>
        <td>${escapeHtml(g.run_group_id)}</td>
        <td>${escapeHtml(g.benchmark_id)}</td>
        <td>${escapeHtml(g.task_id)}</td>
        <td>${g.harnesses.map((h) => `<span class="harness-pill harness-${h}">${escapeHtml(h)}</span>`).join(" ")}</td>
        <td><button type="button" class="diff-open" data-run-group="${escapeHtml(g.run_group_id)}" data-benchmark="${escapeHtml(g.benchmark_id)}" data-task="${escapeHtml(g.task_id)}">View</button></td>
      </tr>`,
    )
    .join("");
}

async function loadDiffPayload(runGroupId, benchmarkId, taskId) {
  const url = `/api/trajectories/${encodeURIComponent(runGroupId)}/${encodeURIComponent(benchmarkId)}/${encodeURIComponent(taskId)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: String(err), harnesses: {} };
  }
}

function entryStepIndex(entry, fallback) {
  const value = Number(entry?.step_index);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function alignByStep(harnessEntries) {
  const steps = new Set();
  const entriesByHarness = {};
  for (const h of HARNESS_ORDER) {
    const list = harnessEntries[h] || [];
    const byStep = new Map();
    list.forEach((entry, index) => {
      const step = entryStepIndex(entry, index);
      steps.add(step);
      byStep.set(step, entry);
    });
    entriesByHarness[h] = byStep;
  }
  return [...steps]
    .sort((a, b) => a - b)
    .map((step) => {
      const cells = {};
      for (const h of HARNESS_ORDER) {
        cells[h] = entriesByHarness[h]?.get(step) || null;
      }
      return { step, cells };
    });
}

function formatToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((tc) => {
      const args = (() => {
        try {
          return JSON.stringify(tc.arguments);
        } catch {
          return String(tc.arguments);
        }
      })();
      return `${escapeHtml(tc.name || "?")}(${escapeHtml(args || "")})`;
    })
    .join("\n");
}

function toolCallsFor(entry) {
  const response = entry?.response || {};
  if (Array.isArray(response.toolCalls)) return response.toolCalls;
  if (Array.isArray(response.tool_calls)) return response.tool_calls;
  const params = response.params;
  if (params && Array.isArray(params.tool_calls)) return params.tool_calls;
  return [];
}

function responseTextFor(entry) {
  const response = entry?.response || {};
  const raw =
    response.text ??
    response.content ??
    response.response_text ??
    response.output_text ??
    response.output ??
    "";
  if (typeof raw === "string") return raw;
  return safeJson(raw);
}

function cellText(entry) {
  if (!entry) return "";
  const role = entry.request?.messages?.length
    ? entry.request.messages[entry.request.messages.length - 1].role
    : "(no prior)";
  const text = responseTextFor(entry);
  const toolCalls = formatToolCalls(toolCallsFor(entry));
  const parts = [`[role: ${escapeHtml(role)}]`, escapeHtml(text)];
  if (toolCalls) parts.push(`<div class="tool-calls">${toolCalls}</div>`);
  return parts.join("<br>");
}

function classifyRow(cells, presentHarnesses) {
  // Pull non-null cells for present harnesses.
  const populated = presentHarnesses
    .map((h) => cells[h])
    .filter((entry) => entry !== null && entry !== undefined);
  if (populated.length < 2) return "diff-equal";
  const texts = populated.map(responseTextFor);
  const someHasTool = populated.some((e) => toolCallsFor(e).length > 0);
  const allHaveTool = populated.every((e) => toolCallsFor(e).length > 0);
  if (someHasTool && !allHaveTool) return "diff-tool-only";
  const firstText = texts[0];
  const sameText = texts.every((t) => t === firstText);
  return sameText ? "diff-equal" : "diff-differ";
}

function renderDiffDetail(payload, group) {
  const panel = document.getElementById("diff-detail-panel");
  const title = document.getElementById("diff-detail-title");
  const head = document.getElementById("diff-table-head");
  const body = document.getElementById("diff-table-body");
  if (!panel || !title || !head || !body) return;
  panel.hidden = false;
  title.textContent = `${group.benchmark_id} :: ${group.task_id}`;

  if (payload.error) {
    head.innerHTML = "";
    body.innerHTML = `<tr><td class="muted">Failed to load: ${escapeHtml(payload.error)}</td></tr>`;
    return;
  }

  const harnessEntries = payload.harnesses || {};
  const presentHarnesses = HARNESS_ORDER.filter(
    (h) => Array.isArray(harnessEntries[h]) && harnessEntries[h].length > 0,
  );
  if (presentHarnesses.length === 0) {
    head.innerHTML = "";
    body.innerHTML = `<tr><td class="muted">No canonical trajectories available for this group.</td></tr>`;
    return;
  }

  head.innerHTML = `<tr><th>Step</th>${presentHarnesses
    .map((h) => `<th class="harness-${h}">${escapeHtml(h)}</th>`)
    .join("")}</tr>`;

  const rows = alignByStep(harnessEntries);
  body.innerHTML = rows
    .map((row) => {
      const klass = classifyRow(row.cells, presentHarnesses);
      const cells = presentHarnesses
        .map(
          (h) =>
            `<td class="diff-cell ${klass}">${cellText(row.cells[h])}</td>`,
        )
        .join("");
      return `<tr><td class="diff-step">${row.step}</td>${cells}</tr>`;
    })
    .join("");
}

async function openDiff(runGroupId, benchmarkId, taskId) {
  const group = state.diffGroups.find(
    (g) =>
      g.run_group_id === runGroupId &&
      g.benchmark_id === benchmarkId &&
      g.task_id === taskId,
  ) || { run_group_id: runGroupId, benchmark_id: benchmarkId, task_id: taskId };
  state.diffSelection = group;
  const payload = await loadDiffPayload(runGroupId, benchmarkId, taskId);
  state.diffPayload = payload;
  renderDiffDetail(payload, group);
}

function computePlaybackRuns() {
  if (!state.data) {
    state.playbackRuns = [];
    return;
  }
  state.playbackRuns = (state.data.runs || [])
    .filter((row) => row.status === "succeeded")
    .filter((row) => HARNESS_ORDER.includes(textValue(row.agent)))
    .filter((row) => canonicalEntryCount(row) > 0)
    .sort((a, b) => compareValues(a, b, "started_at", "desc"));
}

function renderPlaybackRuns() {
  const body = document.getElementById("playback-runs-body");
  if (!body) return;
  const rows = state.playbackRuns;
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No successful runs with canonical trajectories yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.run_group_id)}</td>
        <td>${escapeHtml(row.benchmark_id)}</td>
        <td>${escapeHtml(row.run_id)}</td>
        <td><span class="harness-pill harness-${escapeHtml(textValue(row.agent))}">${escapeHtml(row.agent)}</span></td>
        <td>${canonicalEntryCount(row)}</td>
        <td>${escapeHtml(row.started_at)}</td>
        <td><button type="button" class="playback-open" data-run-group="${escapeHtml(row.run_group_id)}" data-benchmark="${escapeHtml(row.benchmark_id)}" data-task="${escapeHtml(row.run_id)}" data-harness="${escapeHtml(row.agent)}">Play</button></td>
      </tr>`,
    )
    .join("");
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageContentText(message) {
  const content = message?.content ?? message?.text ?? message?.value ?? "";
  if (typeof content === "string") return content;
  return safeJson(content);
}

function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  return messages
    .map((message, index) => {
      const role = escapeHtml(
        message?.role || message?.from || `message ${index}`,
      );
      return `<div class="message-row">
        <div class="message-role">${role}</div>
        <pre>${escapeHtml(messageContentText(message))}</pre>
      </div>`;
    })
    .join("");
}

function renderRequest(entry) {
  const request = entry?.request || {};
  if (Array.isArray(request.messages) && request.messages.length > 0) {
    return renderMessages(request.messages);
  }
  const prompt =
    request.prompt ??
    request.prompt_text ??
    request.userPrompt ??
    request.input ??
    request.input_text;
  if (prompt !== undefined && prompt !== null) {
    return `<pre>${escapeHtml(typeof prompt === "string" ? prompt : safeJson(prompt))}</pre>`;
  }
  return `<pre>${escapeHtml(safeJson(request))}</pre>`;
}

function renderToolCallsBlock(entry) {
  const calls = toolCallsFor(entry);
  if (!calls.length) {
    return `<p class="muted">No tool calls recorded for this step.</p>`;
  }
  return `<pre>${escapeHtml(safeJson(calls))}</pre>`;
}

function renderUsage(entry) {
  const response = entry?.response || {};
  const usage = {
    response_usage: response.usage || null,
    trajectoryTotals: entry?.trajectoryTotals || null,
    cacheStats: entry?.cacheStats || null,
  };
  if (!usage.response_usage && !usage.trajectoryTotals && !usage.cacheStats) {
    return `<p class="muted">No usage metadata recorded for this step.</p>`;
  }
  return `<pre>${escapeHtml(safeJson(usage))}</pre>`;
}

function playbackEntries() {
  const harnesses = state.playbackPayload?.harnesses || {};
  const entries = harnesses[state.playbackHarness];
  return Array.isArray(entries) ? entries : [];
}

function playbackTaskLabel(selection) {
  const taskIds = state.playbackPayload?.task_ids?.[state.playbackHarness];
  if (Array.isArray(taskIds) && taskIds.length > 0) {
    return taskIds.join(", ");
  }
  return selection?.task_id || "";
}

function renderPlaybackDetail() {
  const panel = document.getElementById("playback-detail-panel");
  const title = document.getElementById("playback-detail-title");
  const subtitle = document.getElementById("playback-detail-subtitle");
  const harnessSelect = document.getElementById("playback-harness-select");
  const prev = document.getElementById("playback-prev");
  const next = document.getElementById("playback-next");
  const stepInput = document.getElementById("playback-step-index");
  const stepTotal = document.getElementById("playback-step-total");
  const body = document.getElementById("playback-step-body");
  if (
    !panel ||
    !title ||
    !subtitle ||
    !harnessSelect ||
    !prev ||
    !next ||
    !stepInput ||
    !stepTotal ||
    !body
  )
    return;

  const selection = state.playbackSelection;
  panel.hidden = false;
  if (!selection) {
    title.textContent = "Playback";
    subtitle.textContent = "";
    body.innerHTML = `<p class="muted">Choose a trajectory run to play.</p>`;
    return;
  }

  title.textContent = `${selection.benchmark_id} :: ${playbackTaskLabel(selection)}`;
  subtitle.textContent = `run_group_id=${selection.run_group_id}`;

  if (state.playbackPayload?.error) {
    body.innerHTML = `<p class="muted">Failed to load: ${escapeHtml(state.playbackPayload.error)}</p>`;
    return;
  }

  const harnesses = state.playbackPayload?.harnesses || {};
  const availableHarnesses = HARNESS_ORDER.filter(
    (h) => Array.isArray(harnesses[h]) && harnesses[h].length > 0,
  );
  harnessSelect.innerHTML = availableHarnesses
    .map(
      (h) =>
        `<option value="${escapeHtml(h)}"${h === state.playbackHarness ? " selected" : ""}>${escapeHtml(h)}</option>`,
    )
    .join("");
  harnessSelect.disabled = availableHarnesses.length <= 1;

  const entries = playbackEntries();
  if (!entries.length) {
    body.innerHTML = `<p class="muted">No canonical entries for ${escapeHtml(state.playbackHarness)}.</p>`;
    prev.disabled = true;
    next.disabled = true;
    stepInput.disabled = true;
    stepTotal.textContent = "0 steps";
    return;
  }

  state.playbackStepIndex = Math.min(
    Math.max(0, state.playbackStepIndex),
    entries.length - 1,
  );
  const entry = entries[state.playbackStepIndex];
  const displayedStep = entry?.step_index ?? state.playbackStepIndex;
  prev.disabled = state.playbackStepIndex <= 0;
  next.disabled = state.playbackStepIndex >= entries.length - 1;
  stepInput.disabled = false;
  stepInput.min = "0";
  stepInput.max = String(entries.length - 1);
  stepInput.value = String(state.playbackStepIndex);
  stepTotal.textContent = `${state.playbackStepIndex + 1} of ${entries.length} (recorded step_index ${displayedStep})`;

  body.innerHTML = `<div class="playback-step-grid">
    <section class="playback-card">
      <h3>Prompt</h3>
      ${renderRequest(entry)}
    </section>
    <section class="playback-card">
      <h3>Output</h3>
      <pre>${escapeHtml(responseTextFor(entry))}</pre>
    </section>
    <section class="playback-card">
      <h3>Tool Calls</h3>
      ${renderToolCallsBlock(entry)}
    </section>
    <section class="playback-card">
      <h3>Usage</h3>
      ${renderUsage(entry)}
    </section>
    <section class="playback-card playback-card-wide">
      <h3>Step Metadata</h3>
      <pre>${escapeHtml(
        safeJson({
          agent_id: entry?.agent_id,
          boundary: entry?.boundary,
          model: entry?.model,
          timestamp_ms: entry?.timestamp_ms,
          scenarioId: entry?.scenarioId,
          batchId: entry?.batchId,
          metadata: entry?.metadata || {},
        }),
      )}</pre>
    </section>
  </div>`;
}

async function openPlayback(runGroupId, benchmarkId, taskId, harness) {
  const payload = await loadDiffPayload(runGroupId, benchmarkId, taskId);
  const availableHarnesses = HARNESS_ORDER.filter(
    (h) =>
      Array.isArray(payload.harnesses?.[h]) && payload.harnesses[h].length > 0,
  );
  const selectedHarness = availableHarnesses.includes(harness)
    ? harness
    : availableHarnesses[0] || harness;
  state.playbackSelection = {
    run_group_id: runGroupId,
    benchmark_id: benchmarkId,
    task_id: taskId,
  };
  state.playbackPayload = payload;
  state.playbackHarness = selectedHarness;
  state.playbackStepIndex = 0;
  renderPlaybackDetail();
}

function setActiveTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.tab === tabName);
  });
}

async function loadData() {
  const endpoints = [
    "/api/viewer-data",
    "../benchmark_results/viewer_data.json",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !Array.isArray(data.runs)) continue;
      return data;
    } catch (_err) {}
  }
  throw new Error("Unable to load benchmark data");
}

function wireControls() {
  const sortBy = document.getElementById("sort-by");
  const sortOrder = document.getElementById("sort-order");
  const filterBenchmark = document.getElementById("filter-benchmark");
  const filterStatus = document.getElementById("filter-status");
  const filterSearch = document.getElementById("filter-search");
  const playbackHarnessSelect = document.getElementById(
    "playback-harness-select",
  );
  const playbackPrev = document.getElementById("playback-prev");
  const playbackNext = document.getElementById("playback-next");
  const playbackStepIndex = document.getElementById("playback-step-index");

  sortBy.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    render();
  });
  sortOrder.addEventListener("change", (event) => {
    state.sortOrder = event.target.value;
    render();
  });
  filterBenchmark.addEventListener("change", (event) => {
    state.benchmark = event.target.value;
    render();
  });
  filterStatus.addEventListener("change", (event) => {
    state.status = event.target.value;
    render();
  });
  filterSearch.addEventListener("input", (event) => {
    state.search = event.target.value;
    render();
  });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (state.sortBy === key) {
        state.sortOrder = state.sortOrder === "asc" ? "desc" : "asc";
      } else {
        state.sortBy = key;
        state.sortOrder = key === "started_at" ? "desc" : "asc";
      }
      sortBy.value = state.sortBy;
      sortOrder.value = state.sortOrder;
      render();
    });
  });

  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) setActiveTab(tab);
    });
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.classList.contains("diff-open")) {
      const runGroupId = target.dataset.runGroup || "";
      const benchmarkId = target.dataset.benchmark || "";
      const taskId = target.dataset.task || "";
      if (runGroupId && benchmarkId && taskId) {
        void openDiff(runGroupId, benchmarkId, taskId);
      }
      return;
    }
    if (target.classList.contains("playback-open")) {
      const runGroupId = target.dataset.runGroup || "";
      const benchmarkId = target.dataset.benchmark || "";
      const taskId = target.dataset.task || "";
      const harness = target.dataset.harness || "";
      if (runGroupId && benchmarkId && taskId && harness) {
        setActiveTab("playback");
        void openPlayback(runGroupId, benchmarkId, taskId, harness);
      }
    }
  });

  playbackHarnessSelect?.addEventListener("change", (event) => {
    state.playbackHarness = event.target.value;
    state.playbackStepIndex = 0;
    renderPlaybackDetail();
  });
  playbackPrev?.addEventListener("click", () => {
    state.playbackStepIndex = Math.max(0, state.playbackStepIndex - 1);
    renderPlaybackDetail();
  });
  playbackNext?.addEventListener("click", () => {
    state.playbackStepIndex += 1;
    renderPlaybackDetail();
  });
  playbackStepIndex?.addEventListener("change", (event) => {
    const nextIndex = Number(event.target.value);
    if (Number.isFinite(nextIndex)) {
      state.playbackStepIndex = Math.trunc(nextIndex);
      renderPlaybackDetail();
    }
  });
}

async function main() {
  wireControls();
  try {
    const data = await loadData();
    state.data = data;
    setGeneratedAt(data);
    populateFilters(data);
    render();
  } catch (err) {
    document.getElementById("generated-at").textContent =
      `Failed to load data: ${err}`;
  }
}

main();
