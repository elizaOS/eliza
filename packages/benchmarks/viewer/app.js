const state = {
  data: null,
  sortBy: "started_at",
  sortOrder: "desc",
  benchmark: "",
  status: "",
  search: "",
};

const numericKeys = new Set([
  "score",
  "high_score_value",
  "delta_to_high_score",
  "duration_seconds",
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
  const generatedAt = data.generated_at ? new Date(data.generated_at).toLocaleString() : "n/a";
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
    .map((it) => `<article class="card"><div class="k">${it.k}</div><div class="v">${it.v}</div></article>`)
    .join("");
}

function populateFilters(data) {
  const runs = data.runs || [];
  const benchmarks = [...new Set(runs.map((r) => textValue(r.benchmark_id)).filter(Boolean))].sort();
  const statuses = [...new Set(runs.map((r) => textValue(r.status)).filter(Boolean))].sort();

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
  if (state.benchmark) runs = runs.filter((r) => textValue(r.benchmark_id) === state.benchmark);
  if (state.status) runs = runs.filter((r) => textValue(r.status) === state.status);
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
      <td>${row.high_score_value ?? ""}</td>
      <td>${row.delta_to_high_score ?? ""}</td>
    </tr>`
    )
    .join("");
}

function render() {
  if (!state.data) return;
  const runs = getFilteredRuns();
  renderCards(state.data, runs);
  renderRunsTable(runs);
  renderLatestScores(state.data);
}

async function loadData() {
  const endpoints = ["/api/viewer-data", "../benchmark_results/viewer_data.json"];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data || !Array.isArray(data.runs)) continue;
      return data;
    } catch (_err) {
      continue;
    }
  }
  throw new Error("Unable to load benchmark data");
}

function wireControls() {
  const sortBy = document.getElementById("sort-by");
  const sortOrder = document.getElementById("sort-order");
  const filterBenchmark = document.getElementById("filter-benchmark");
  const filterStatus = document.getElementById("filter-status");
  const filterSearch = document.getElementById("filter-search");

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
    document.getElementById("generated-at").textContent = `Failed to load data: ${err}`;
  }
}

main();
