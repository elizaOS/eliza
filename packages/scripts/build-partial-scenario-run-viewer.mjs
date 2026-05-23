#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function parseArgs(argv) {
  const options = {
    runDir: "",
    wrapperReport: "",
    providerName: "unknown",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run-dir") {
      options.runDir = path.resolve(REPO_ROOT, argv[++i] || "");
    } else if (arg === "--wrapper-report") {
      options.wrapperReport = path.resolve(REPO_ROOT, argv[++i] || "");
    } else if (arg === "--provider") {
      options.providerName = argv[++i] || "unknown";
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.runDir) throw new Error("--run-dir is required");
  return options;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function walkJsonFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonFiles(filePath));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(filePath);
  }
  return files.sort();
}

function preview(value, max = 280) {
  const text =
    typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function modelText(model) {
  if (!model || typeof model !== "object") return "";
  return (
    model.responseText ??
    model.response_text ??
    model.outputText ??
    model.output_text ??
    model.completion ??
    model.result ??
    model.response ??
    ""
  );
}

function summarizeStage(stage) {
  const model = stage?.model && typeof stage.model === "object" ? stage.model : null;
  const messages = Array.isArray(model?.messages) ? model.messages : [];
  const firstMessage = messages.find((message) => message?.content)?.content;
  return {
    stageId: String(stage?.stageId || ""),
    kind: String(stage?.kind || "unknown"),
    latencyMs: typeof stage?.latencyMs === "number" ? stage.latencyMs : undefined,
    modelType: String(model?.modelType || model?.type || ""),
    provider: String(model?.provider || ""),
    inputPreview: preview(firstMessage),
    outputPreview: preview(modelText(model)),
    messageCount: messages.length,
  };
}

function trajectorySummaries(runDir) {
  const trajectoryDir = path.join(runDir, "trajectories");
  return walkJsonFiles(trajectoryDir).flatMap((filePath) => {
    try {
      const trajectory = readJson(filePath);
      const stages = Array.isArray(trajectory.stages) ? trajectory.stages : [];
      return [
        {
          filePath,
          relativePath: path.relative(runDir, filePath),
          trajectoryId: String(trajectory.trajectoryId || path.basename(filePath, ".json")),
          scenarioId: String(trajectory.scenarioId || ""),
          status: String(trajectory.status || "unknown"),
          startedAt: trajectory.startedAt,
          endedAt: trajectory.endedAt,
          rootMessage: trajectory.rootMessage?.text || "",
          stageCount: stages.length,
          stages: stages.map(summarizeStage),
        },
      ];
    } catch {
      return [];
    }
  });
}

function statusRowsFromStdout(stdout) {
  const rows = new Map();
  const discovered = stdout.match(/discovered\s+(\d+)\s+scenario\(s\)/)?.[1];
  for (const line of stdout.split(/\r?\n/)) {
    const started = line.match(/\[eliza-scenarios\]\s+▶\s+(.+)$/);
    if (started) {
      const id = started[1].trim();
      rows.set(id, rows.get(id) ?? { id, status: "started" });
      continue;
    }
    const completed = line.match(
      /\[eliza-scenarios\]\s+[✓✗∼]\s+(.+?)\s+(passed|failed|skipped)\s+\((\d+)ms\)(?:\s+—\s+(.+))?$/,
    );
    if (completed) {
      const [, id, status, durationMs, skipReason] = completed;
      rows.set(id.trim(), {
        id: id.trim(),
        status,
        durationMs: Number(durationMs),
        skipReason: skipReason || undefined,
      });
    }
  }
  return {
    expectedScenarioCount: discovered ? Number(discovered) : undefined,
    rows: [...rows.values()],
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Partial Scenario Run</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#172017; --muted:#5e675d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; --warn:#8a5a00; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; z-index:3; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    main { padding:14px 20px 22px; display:grid; gap:12px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .panel { overflow:hidden; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .body { padding:12px; }
    .muted { color:var(--muted); }
    .ok { color:var(--ok); font-weight:700; }
    .bad { color:var(--bad); font-weight:700; }
    .warn { color:var(--warn); font-weight:700; }
    input,select { width:100%; max-width:360px; border:1px solid var(--line); border-radius:6px; padding:7px 8px; margin:0 8px 8px 0; background:#fff; color:var(--ink); }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:65px; background:#f7faf4; z-index:2; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    details { margin-top:6px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; max-height:280px; overflow:auto; }
  </style>
</head>
<body>
  <header><h1>Partial Scenario Run</h1><div id="meta" class="muted"></div></header>
  <main>
    <section class="cards" id="cards"></section>
    <section class="panel"><h2>Scenarios</h2><div class="body"><input id="q" type="search" placeholder="Search scenario id..." /><select id="status"><option value="">all statuses</option></select><div id="table"></div></div></section>
  </main>
  <script src="./data.js"></script>
  <script>
    const data = window.PARTIAL_SCENARIO_RUN || {};
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = (data.runDir || "") + " · " + (data.startedAtIso || "") + " → " + (data.completedAtIso || "");
    const totals = data.totals || {};
    const cards = [["expected", data.expectedScenarioCount], ["attempted", totals.attempted], ["passed", totals.passed], ["failed", totals.failed], ["skipped", totals.skipped], ["trajectories", totals.trajectories], ["timed out", data.timedOut ? "yes" : "no"]];
    document.getElementById("cards").innerHTML = cards.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? "") + '</b></div>').join("");
    const statuses = [...new Set((data.scenarios || []).map(s => s.status).filter(Boolean))].sort();
    document.getElementById("status").innerHTML += statuses.map(s => '<option>' + esc(s) + '</option>').join("");
    function cls(status) { return status === "passed" ? "ok" : status === "failed" ? "bad" : "warn"; }
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const status = document.getElementById("status").value;
      return (data.scenarios || []).filter(s => (!q || s.id.toLowerCase().includes(q)) && (!status || s.status === status));
    }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>scenario</th><th>status</th><th>duration</th><th>trajectories</th><th>call summary</th></tr></thead><tbody>' + rows.map(s => {
        const stages = (s.trajectories || []).flatMap(t => t.stages || []);
        const details = stages.slice(0, 20).map(st => '<tr><td>' + esc(st.kind) + '</td><td>' + esc(st.modelType || st.provider) + '</td><td>' + esc(st.latencyMs ?? "") + '</td><td><code>' + esc(st.inputPreview) + '</code></td><td><code>' + esc(st.outputPreview) + '</code></td></tr>').join("");
        return '<tr><td><code>' + esc(s.id) + '</code></td><td class="' + cls(s.status) + '">' + esc(s.status) + '</td><td>' + esc(s.durationMs ?? "") + '</td><td>' + esc((s.trajectories || []).length) + '</td><td><details><summary>' + esc(stages.length) + ' stages</summary><table><thead><tr><th>kind</th><th>model/tool</th><th>ms</th><th>input</th><th>output</th></tr></thead><tbody>' + details + '</tbody></table></details></td></tr>';
      }).join("") + '</tbody></table>';
    }
    document.getElementById("q").addEventListener("input", render);
    document.getElementById("status").addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.runDir, { recursive: true });
  const wrapper = options.wrapperReport && existsSync(options.wrapperReport)
    ? readJson(options.wrapperReport)
    : {};
  const stdout = String(wrapper.stdout || "");
  const parsed = statusRowsFromStdout(stdout);
  const trajectories = trajectorySummaries(options.runDir);
  const trajectoriesByScenario = new Map();
  for (const trajectory of trajectories) {
    const key = trajectory.scenarioId || "(unknown)";
    const list = trajectoriesByScenario.get(key) || [];
    list.push(trajectory);
    trajectoriesByScenario.set(key, list);
  }
  const statusById = new Map(parsed.rows.map((row) => [row.id, row]));
  for (const scenarioId of trajectoriesByScenario.keys()) {
    if (!statusById.has(scenarioId)) {
      statusById.set(scenarioId, { id: scenarioId, status: "trajectory-only" });
    }
  }
  const scenarios = [...statusById.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((row) => ({
      ...row,
      trajectories: trajectoriesByScenario.get(row.id) || [],
    }));
  const totals = {
    attempted: scenarios.length,
    passed: scenarios.filter((row) => row.status === "passed").length,
    failed: scenarios.filter((row) => row.status === "failed").length,
    skipped: scenarios.filter((row) => row.status === "skipped").length,
    other: scenarios.filter(
      (row) => !["passed", "failed", "skipped"].includes(row.status),
    ).length,
    trajectories: trajectories.length,
  };
  const payload = {
    schema: "eliza_partial_scenario_run_v1",
    partial: true,
    providerName: options.providerName,
    runDir: options.runDir,
    expectedScenarioCount: parsed.expectedScenarioCount,
    startedAtIso: wrapper.startedAt || "",
    completedAtIso: wrapper.completedAt || "",
    timedOut: Boolean(wrapper.timedOut),
    timeoutMs: wrapper.timeoutMs,
    wrapperExitCode: wrapper.exitCode,
    totalCount: scenarios.length,
    passedCount: totals.passed,
    failedCount: totals.failed,
    skippedCount: totals.skipped,
    totals,
    scenarios,
    artifactPaths: {
      runDir: options.runDir,
      matrixJson: path.join(options.runDir, "matrix.json"),
      viewerIndex: path.join(options.runDir, "viewer", "index.html"),
      viewerData: path.join(options.runDir, "viewer", "data.js"),
      wrapperReport: options.wrapperReport || "",
    },
  };
  mkdirSync(path.join(options.runDir, "viewer"), { recursive: true });
  writeFileSync(path.join(options.runDir, "matrix.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(options.runDir, "viewer", "data.js"), `window.PARTIAL_SCENARIO_RUN = ${JSON.stringify(payload)};\n`, "utf8");
  writeFileSync(path.join(options.runDir, "viewer", "index.html"), html(), "utf8");
  process.stdout.write(
    `partial scenario viewer ${path.join(options.runDir, "viewer", "index.html")} (${totals.attempted}/${parsed.expectedScenarioCount || "?"} attempted, ${totals.trajectories} trajectories)\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
