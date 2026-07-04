#!/usr/bin/env node
// Exercises run live test with artifacts automation behavior with deterministic script fixtures.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_ROOT = path.join(REPO_ROOT, "reports", "live-test-runs");

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slug(value) {
  return String(value || "live-test")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseArgs(argv) {
  const options = {
    label: "",
    reportRoot: DEFAULT_REPORT_ROOT,
    timeoutMs: 0,
    command: [],
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      options.command = argv.slice(index + 1);
      break;
    }
    if (arg === "--label") {
      const next = argv[index + 1];
      if (!next) throw new Error("--label requires a value");
      options.label = next;
      index += 2;
      continue;
    }
    if (arg === "--report-root") {
      const next = argv[index + 1];
      if (!next) throw new Error("--report-root requires a value");
      options.reportRoot = path.resolve(REPO_ROOT, next);
      index += 2;
      continue;
    }
    if (arg === "--timeout-ms") {
      const next = argv[index + 1];
      if (!next) throw new Error("--timeout-ms requires a value");
      const timeoutMs = Number(next);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error("--timeout-ms must be a non-negative number");
      }
      options.timeoutMs = timeoutMs;
      index += 2;
      continue;
    }
    throw new Error(`unknown argument before --: ${arg}`);
  }
  if (options.command.length === 0) {
    throw new Error(
      "missing command. Usage: node packages/scripts/run-live-test-with-artifacts.mjs --label name -- <command...>",
    );
  }
  return options;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Test Run</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#172017; --muted:#5e675d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    main { padding:16px 20px 20px; display:grid; gap:12px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .body { padding:12px; }
    .muted { color:var(--muted); }
    .ok { color:var(--ok); font-weight:700; }
    .bad { color:var(--bad); font-weight:700; }
    pre { margin:0; max-height:520px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:10px 12px; }
    table { width:100%; border-collapse:collapse; }
    td,th { border-bottom:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; }
  </style>
</head>
<body>
  <header><h1>Live Test Run</h1><div id="meta" class="muted"></div></header>
  <main>
    <section class="panel"><h2>Summary</h2><div id="summary" class="body"></div></section>
    <section class="panel"><h2>Command</h2><pre id="command"></pre></section>
    <section class="panel"><h2>stdout</h2><pre id="stdout"></pre></section>
    <section class="panel"><h2>stderr</h2><pre id="stderr"></pre></section>
    <section class="panel"><h2>Trajectory JSONL Events</h2><pre id="trajectory"></pre></section>
    <section class="panel"><h2>Structured LLM Calls</h2><pre id="llmCalls"></pre></section>
    <section class="panel"><h2>Report JSON</h2><pre id="report"></pre></section>
  </main>
  <script src="./data.js"></script>
  <script>
    const data = window.LIVE_TEST_RUN || {};
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = (data.runDir || "") + " · " + (data.startedAt || "") + " → " + (data.completedAt || "");
    document.getElementById("summary").innerHTML = '<table><tbody>' + [
      ["label", data.label],
      ["status", data.exitCode === 0 ? '<span class="ok">passed</span>' : '<span class="bad">failed</span>'],
      ["exit", data.exitCode],
      ["duration ms", data.durationMs],
      ["stdout bytes", data.stdoutBytes],
      ["stderr bytes", data.stderrBytes],
    ].map(([k,v]) => '<tr><th>' + esc(k) + '</th><td>' + v + '</td></tr>').join("") + '</tbody></table>';
    document.getElementById("command").textContent = JSON.stringify(data.command || [], null, 2);
    document.getElementById("stdout").textContent = data.stdout || "";
    document.getElementById("stderr").textContent = data.stderr || "";
    document.getElementById("trajectory").textContent = (data.events || []).map(e => JSON.stringify(e)).join("\\n");
    document.getElementById("llmCalls").textContent = JSON.stringify(data.structuredLlmCalls || [], null, 2);
    document.getElementById("report").textContent = JSON.stringify(data, null, 2);
  </script>
</body>
</html>`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function usageFrom(record) {
  const usage =
    record?.usage && typeof record.usage === "object"
      ? record.usage
      : record || {};
  return {
    promptTokens: number(
      usage.promptTokens ??
        usage.prompt_tokens ??
        usage.inputTokens ??
        usage.input_tokens,
    ),
    completionTokens: number(
      usage.completionTokens ??
        usage.completion_tokens ??
        usage.outputTokens ??
        usage.output_tokens,
    ),
    totalTokens: number(usage.totalTokens ?? usage.total_tokens),
    cacheReadInputTokens: number(
      usage.cacheReadInputTokens ??
        usage.cache_read_input_tokens ??
        usage.cacheReadTokens ??
        usage.cachedTokens,
    ),
    cacheCreationInputTokens: number(
      usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens,
    ),
  };
}

function readStructuredLlmCalls(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line);
        const usage = usageFrom(parsed);
        return {
          type: "llm_call",
          timestamp: parsed.timestamp || new Date().toISOString(),
          callId: parsed.callId || parsed.id || `llm-call-${index + 1}`,
          provider: parsed.provider || "",
          model: parsed.model || "",
          purpose: parsed.purpose || parsed.stepType || "live-test",
          systemPrompt: parsed.systemPrompt || "",
          userPrompt: parsed.userPrompt || parsed.prompt || "",
          messages: Array.isArray(parsed.messages) ? parsed.messages : [],
          response: parsed.response || parsed.text || "",
          finishReason: parsed.finishReason || "",
          latencyMs: number(parsed.latencyMs ?? parsed.latency_ms),
          usage,
          raw: parsed,
        };
      } catch (error) {
        return {
          type: "llm_call_parse_error",
          timestamp: new Date().toISOString(),
          lineNumber: index + 1,
          error: error instanceof Error ? error.message : String(error),
          rawLine: line,
        };
      }
    });
}

function structuredLlmSummary(records) {
  const calls = records.filter((record) => record.type === "llm_call");
  return calls.reduce(
    (summary, record) => {
      summary.callCount += 1;
      summary.promptTokens += number(record.usage?.promptTokens);
      summary.completionTokens += number(record.usage?.completionTokens);
      const total = number(record.usage?.totalTokens);
      summary.totalTokens +=
        total ||
        number(record.usage?.promptTokens) +
          number(record.usage?.completionTokens);
      summary.cacheReadInputTokens += number(
        record.usage?.cacheReadInputTokens,
      );
      summary.cacheCreationInputTokens += number(
        record.usage?.cacheCreationInputTokens,
      );
      return summary;
    },
    {
      callCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = options.label || options.command[0];
  const runDir = path.join(
    options.reportRoot,
    `${timestampId()}-${slug(label)}`,
  );
  mkdirSync(runDir, { recursive: true });
  const llmCallsJsonl = path.join(runDir, "llm-calls.jsonl");
  const startedAt = new Date();
  const events = [
    {
      type: "start",
      timestamp: startedAt.toISOString(),
      command: options.command,
      cwd: REPO_ROOT,
      label,
      timeoutMs: options.timeoutMs,
    },
  ];
  const child = spawn(options.command[0], options.command.slice(1), {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELIZA_LIVE_TEST_RUN_DIR: runDir,
      ELIZA_LIVE_TEST_ARTIFACT_DIR: runDir,
      ELIZA_LIVE_TEST_LLM_CALLS_JSONL: llmCallsJsonl,
      ELIZA_LIVE_TEST_TRAJECTORY_JSONL: llmCallsJsonl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
    events.push({ type: "stdout", timestamp: new Date().toISOString(), text });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
    events.push({ type: "stderr", timestamp: new Date().toISOString(), text });
  });
  let timedOut = false;
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          events.push({
            type: "timeout",
            timestamp: new Date().toISOString(),
            timeoutMs: options.timeoutMs,
          });
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
  const exitCode = await new Promise((resolve) => {
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      events.push({
        type: "error",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      events.push({
        type: "exit",
        timestamp: new Date().toISOString(),
        code: timedOut ? 124 : (code ?? 1),
        signal,
      });
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
  const completedAt = new Date();
  const structuredLlmCalls = readStructuredLlmCalls(llmCallsJsonl);
  if (!existsSync(llmCallsJsonl)) {
    writeFileSync(llmCallsJsonl, "", "utf8");
  }
  const allEvents = [...events, ...structuredLlmCalls];
  const llmSummary = structuredLlmSummary(structuredLlmCalls);
  const report = {
    schema: "eliza_live_test_run_artifact_v1",
    label,
    runDir,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    command: options.command,
    exitCode,
    timedOut,
    timeoutMs: options.timeoutMs,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stdout,
    stderr,
    events: allEvents,
    processEvents: events,
    structuredLlmCalls,
    structuredLlmSummary: llmSummary,
    artifactPaths: {
      reportJson: path.join(runDir, "report.json"),
      trajectoryJsonl: path.join(runDir, "trajectory.jsonl"),
      llmCallsJsonl,
      viewerIndex: path.join(runDir, "index.html"),
      viewerData: path.join(runDir, "data.js"),
      stdout: path.join(runDir, "stdout.log"),
      stderr: path.join(runDir, "stderr.log"),
    },
  };
  writeFileSync(path.join(runDir, "stdout.log"), stdout, "utf8");
  writeFileSync(path.join(runDir, "stderr.log"), stderr, "utf8");
  writeFileSync(
    path.join(runDir, "trajectory.jsonl"),
    allEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(runDir, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(runDir, "data.js"),
    `window.LIVE_TEST_RUN = ${JSON.stringify(report)};\n`,
    "utf8",
  );
  writeFileSync(path.join(runDir, "index.html"), html(), "utf8");
  process.stdout.write(
    `\n[live-test-artifacts] viewer=${path.join(runDir, "index.html")}\n`,
  );
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
