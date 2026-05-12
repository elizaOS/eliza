#!/usr/bin/env node
/**
 * Trajectory inspection CLI.
 *
 * Reads JSON trajectory files written by trajectory-recorder.ts (the same
 * on-disk format consumed by scripts/analyze-trajectories.mjs) and dumps
 * everything that went into and came out of each model call. Used to validate
 * compaction behavior and reason about prompt size on real recorded data.
 *
 * On-disk schema (recorder format):
 *   {
 *     trajectoryId, agentId, roomId, rootMessage, startedAt, endedAt,
 *     status, metrics: { totalLatencyMs, totalPromptTokens, totalCompletionTokens, ... },
 *     stages: [
 *       {
 *         stageId, kind, startedAt, endedAt, latencyMs,
 *         model: {
 *           modelType, provider, modelName?, prompt?, messages: [{role, content}],
 *           response, toolCalls: [{id, name, args}], usage?, costUsd?,
 *           purpose?, actionType?
 *         },
 *         cache?: ...
 *       }
 *     ]
 *   }
 *
 * The default trajectory directory is ~/.eliza/trajectories. Override with
 * --dir <path> on any subcommand.
 *
 * No external dependencies — pure Node ESM.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Inlined prompt compaction
// ---------------------------------------------------------------------------
//
// Mirror of compactModelPrompt and helpers from
// packages/agent/src/runtime/prompt-compaction.ts. Inlined because that file
// is TypeScript inside a workspace package; loading it from a Node ESM script
// would require either a dist build or --experimental-strip-types. The
// helpers are pure string→string regex transforms — safe to duplicate here
// for an inspection tool. If the source ever drifts, the diff will simply
// report stale results; fix by re-syncing the regexes below.

const CODING_INTENT_RE =
  /\b(code|coding|codebase|repo|repository|pull request|pr\b|branch|merge|commit|deploy|refactor|research|investigate|analy[sz]e|analysis|draft|document|orchestrate|delegate|subtask|parallel|background task|task agent|start_coding_task|spawn_coding_agent|send_to_coding_agent|create_task|spawn_agent|send_to_agent|list_agents|stop_agent)\b|https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\//i;
const PLUGIN_UI_INTENT_RE =
  /\b(plugin|plugins|configure|configuration|setup|install|enable|disable|api key|credential|secret|dashboard|form|ui|interface|\[config:)\b/i;
const WALLET_INTENT_RE =
  /\b(wallet|onchain|on-chain|transaction|tx\b|transfer|swap|trade|send\b|gas|token|bnb|eth|sol|basechain|erc20|balance)\b/i;

function hasIntent(prompt, keywords) {
  const taskMatch = prompt.match(/<task>([\s\S]*?)<\/task>/i);
  const taskText = (taskMatch?.[1] ?? "").slice(0, 2000);
  if (keywords.test(taskText)) return true;
  const msgSection = prompt.indexOf("# Received Message");
  if (msgSection !== -1) {
    const afterHeader = prompt.slice(msgSection + "# Received Message".length);
    const nextSection = afterHeader.search(/\n#|\n<|\n\n\n/);
    const userMsg = (
      nextSection !== -1
        ? afterHeader.slice(0, nextSection)
        : afterHeader.slice(0, 500)
    ).trim();
    if (keywords.test(userMsg)) return true;
  }
  return false;
}

function compactInitialCodeMarker(prompt) {
  return prompt.replace(
    /initial code:\s*([0-9a-f]{8})[0-9a-f-]*/gi,
    "<initial_code>$1</initial_code>",
  );
}
function compactRegistryCatalog(prompt) {
  return prompt.replace(
    /\*\*Available Plugins from Registry \((\d+) total\):[\s\S]*?(?=\n## Project Context \(Workspace\)|\n### AGENTS\.md|$)/g,
    (_m, total) =>
      `**Available Plugins from Registry (${total} total):** [omitted in compact mode; query on demand]\n`,
  );
}
function compactCodingActionExamples(prompt) {
  const next = prompt.replace(
    /\n# (?:Coding|Task) Agent Action Call Examples[\s\S]*?(?=\nPossible response actions:|\n# Available Actions|\n## Project Context \(Workspace\)|$)/g,
    "\n",
  );
  return next.replace(/\nPossible response actions:[^\n]*\n?/g, "\n");
}
function compactUiCatalog(prompt) {
  return prompt.replace(
    /\n## Rich UI Output — you can render interactive components in your replies[\s\S]*?(?=\n## Project Context \(Workspace\)|\n### AGENTS\.md|$)/g,
    "\n",
  );
}
function compactLoadedPluginLists(prompt) {
  const loadedCountMatch = prompt.match(
    /\*\*Loaded Plugins:\*\*[\s\S]*?(?=\n\*\*System Plugins:\*\*)/,
  );
  const loadedCount = loadedCountMatch
    ? (loadedCountMatch[0].match(/\n- /g)?.length ?? 0)
    : 0;
  return prompt.replace(
    /\n\*\*Loaded Plugins:\*\*[\s\S]*?(?=\n\*\*Available Plugins from Registry|\nNo access to role information|\nSECURITY ALERT:|$)/g,
    `\n**Loaded Plugins:** ${loadedCount} loaded [list omitted in compact mode]`,
  );
}
function compactEmoteCatalog(prompt) {
  return prompt.replace(
    /\n## Available Emotes[\s\S]*?(?=\n# Active Workspaces & Agents|\n## Project Context \(Workspace\)|$)/g,
    "\n## Available Emotes\n[emote catalog omitted in compact mode]\n",
  );
}
function compactWorkspaceContextForNonCoding(prompt) {
  return prompt.replace(
    /\n## Project Context \(Workspace\)[\s\S]*?(?=\nAdmin trust:|\nThe current date and time is|\n# Conversation Messages|$)/g,
    "\n## Project Context (Workspace)\n[workspace file contents omitted in compact mode for non-coding intent]\n",
  );
}
function compactUiComponentCatalog(prompt) {
  return prompt.replace(
    /\n### Available components \((\d+) total\)[\s\S]*?(?=\n## Available Emotes|\n## Project Context \(Workspace\)|$)/g,
    (_m, total) =>
      `\n### Available components (${total} total)\n[component catalog omitted in compact mode]\n`,
  );
}
function compactInstalledSkills(prompt) {
  return prompt.replace(
    /\n## Installed Skills \((\d+)\)[\s\S]*?\*Use TOGGLE_SKILL to enable\/disable skills\.[\s\S]*?(?=\nMima is|\n\*\*Loaded Plugins:\*\*|\n## Project Context \(Workspace\)|$)/g,
    (_m, total) =>
      `\n## Installed Skills (${total})\n[skill list omitted in compact mode; query on demand]\n`,
  );
}

export function compactModelPrompt(prompt) {
  const hasCodingIntent = hasIntent(prompt, CODING_INTENT_RE);
  const hasPluginUiIntent = hasIntent(prompt, PLUGIN_UI_INTENT_RE);

  let next = prompt;
  next = compactInitialCodeMarker(next);
  if (!hasCodingIntent) next = compactCodingActionExamples(next);
  next = compactLoadedPluginLists(next);
  next = compactEmoteCatalog(next);
  if (!hasCodingIntent) next = compactInstalledSkills(next);
  if (!hasPluginUiIntent) {
    next = compactRegistryCatalog(next);
    next = compactUiCatalog(next);
  } else {
    next = compactUiComponentCatalog(next);
  }
  if (!hasCodingIntent) next = compactWorkspaceContextForNonCoding(next);
  return next;
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

export function defaultTrajectoryDir() {
  return path.join(os.homedir(), ".eliza", "trajectories");
}

function* walkJson(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkJson(p);
    } else if (e.isFile() && e.name.endsWith(".json")) {
      yield p;
    }
  }
}

export function loadTrajectories(dir) {
  const out = [];
  for (const file of walkJson(dir)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    if (!Array.isArray(parsed.stages)) continue;
    out.push({ file, data: parsed });
  }
  return out;
}

export function loadTrajectoryById(dir, id) {
  for (const { file, data } of loadTrajectories(dir)) {
    if (data.trajectoryId === id) return { file, data };
    // Also accept matches against the file basename minus extension.
    const base = path.basename(file, ".json");
    if (base === id) return { file, data };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

export function summarizeTrajectory(t) {
  const stages = Array.isArray(t.stages) ? t.stages : [];
  let totalTokens = 0;
  for (const s of stages) {
    const u = s?.model?.usage;
    if (u) {
      totalTokens += (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    }
  }
  return {
    id: t.trajectoryId ?? "(no id)",
    source: t.source ?? t.metadata?.source ?? "(unknown)",
    status: t.status ?? "unknown",
    stepCount: stages.length,
    totalTokens,
    startTime: t.startedAt ?? null,
  };
}

export function aggregateStats(t) {
  const stages = Array.isArray(t.stages) ? t.stages : [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let toolCalls = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  let longestPrompt = 0;
  let longestResponse = 0;
  let modelCalls = 0;

  for (const s of stages) {
    const m = s?.model;
    if (!m) continue;
    modelCalls++;
    const u = m.usage ?? {};
    promptTokens += u.promptTokens ?? 0;
    completionTokens += u.completionTokens ?? 0;
    cacheReadTokens += u.cacheReadInputTokens ?? 0;
    cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
    toolCalls += Array.isArray(m.toolCalls) ? m.toolCalls.length : 0;
    const lat = typeof s.latencyMs === "number" ? s.latencyMs : null;
    if (lat !== null) {
      latencyTotal += lat;
      latencyCount++;
    }
    const promptText = assembledPromptFor(m);
    if (promptText.length > longestPrompt) longestPrompt = promptText.length;
    const respText =
      typeof m.response === "string"
        ? m.response
        : JSON.stringify(m.response ?? "");
    if (respText.length > longestResponse) longestResponse = respText.length;
  }

  return {
    modelCalls,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: promptTokens + completionTokens,
    toolCalls,
    avgLatencyMs: latencyCount > 0 ? latencyTotal / latencyCount : 0,
    longestPromptChars: longestPrompt,
    longestResponseChars: longestResponse,
  };
}

/**
 * The recorder writes both `model.prompt` (the raw composed prompt string,
 * when available) and `model.messages` (the chat-format messages). For
 * compaction we want the raw composed prompt; for display we assemble the
 * messages. This helper picks the best representation.
 */
export function assembledPromptFor(model) {
  if (typeof model?.prompt === "string" && model.prompt.length > 0) {
    return model.prompt;
  }
  const messages = Array.isArray(model?.messages) ? model.messages : [];
  return messages
    .map((m) => {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${m.role}]\n${content}`;
    })
    .join("\n\n");
}

export function approxTokens(text) {
  // 4 chars per token heuristic — good enough for compaction reduction %.
  return Math.ceil((text?.length ?? 0) / 4);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const SEP = "─".repeat(72);
const HEAVY = "═".repeat(72);

function truncate(s, max, full) {
  if (full) return s;
  if (typeof s !== "string") s = JSON.stringify(s);
  if (s.length <= max) return s;
  const remaining = s.length - max;
  return `${s.slice(0, max)}… (${remaining} more chars)`;
}

function fmtTime(ts) {
  if (!ts) return "(no timestamp)";
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

// Simple line-based diff: emits unified-diff-style markers (no hunk headers).
// Sufficient for a human eyeballing what compaction stripped.
export function lineDiff(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  // LCS table
  const n = aLines.length;
  const m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push(`  ${aLines[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${aLines[i]}`);
      i++;
    } else {
      out.push(`+ ${bLines[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${aLines[i++]}`);
  while (j < m) out.push(`+ ${bLines[j++]}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cmdList(args) {
  const dir = args.dir ?? defaultTrajectoryDir();
  if (!fs.existsSync(dir)) {
    console.log(`No trajectory directory at ${dir} — nothing to list.`);
    return 0;
  }
  const trajectories = loadTrajectories(dir);
  if (trajectories.length === 0) {
    console.log(`No trajectories found under ${dir}.`);
    return 0;
  }

  const filtered = trajectories
    .map(({ file, data }) => ({ file, data, summary: summarizeTrajectory(data) }))
    .filter((row) => !args.source || row.summary.source === args.source)
    .sort((a, b) => (b.summary.startTime ?? 0) - (a.summary.startTime ?? 0));

  const limit = args.limit ?? 50;
  const rows = filtered.slice(0, limit);

  if (args.format === "json") {
    for (const row of rows) {
      process.stdout.write(
        `${JSON.stringify({ ...row.summary, file: row.file })}\n`,
      );
    }
    return 0;
  }

  console.log(`Trajectories under ${dir}: ${filtered.length} (showing ${rows.length})\n`);
  console.log(
    "ID                                    SOURCE          STATUS     STEPS  TOKENS    STARTED",
  );
  console.log(SEP);
  for (const row of rows) {
    const id = (row.summary.id ?? "(no id)").padEnd(36).slice(0, 36);
    const src = String(row.summary.source ?? "").padEnd(14).slice(0, 14);
    const status = String(row.summary.status ?? "").padEnd(10).slice(0, 10);
    const steps = String(row.summary.stepCount).padStart(5);
    const tokens = String(row.summary.totalTokens).padStart(8);
    const started = fmtTime(row.summary.startTime);
    console.log(`${id}  ${src}  ${status}  ${steps}  ${tokens}  ${started}`);
  }
  return 0;
}

function cmdShow(args) {
  const dir = args.dir ?? defaultTrajectoryDir();
  const id = args.positional[0];
  if (!id) {
    console.error("Usage: inspect-trajectory.mjs show <trajectoryId> [--step N] [--format text|json] [--full]");
    return 2;
  }
  const found = loadTrajectoryById(dir, id);
  if (!found) {
    console.error(`Trajectory not found: ${id} (searched ${dir})`);
    return 1;
  }
  const { file, data } = found;
  const stages = Array.isArray(data.stages) ? data.stages : [];

  const stepFilter = args.step !== undefined ? Number(args.step) : null;
  const selected = stepFilter !== null ? [stages[stepFilter]].filter(Boolean) : stages;

  if (args.format === "json") {
    for (let i = 0; i < selected.length; i++) {
      process.stdout.write(`${JSON.stringify({ stepIndex: i, ...selected[i] })}\n`);
    }
    return 0;
  }

  const full = !!args.full;
  console.log(HEAVY);
  console.log(`Trajectory: ${data.trajectoryId ?? "(no id)"}`);
  console.log(`File:       ${file}`);
  console.log(`Source:     ${data.source ?? data.metadata?.source ?? "(unknown)"}`);
  console.log(`Status:     ${data.status ?? "unknown"}`);
  console.log(`Started:    ${fmtTime(data.startedAt)}`);
  console.log(`Ended:      ${fmtTime(data.endedAt)}`);
  console.log(`Stages:     ${stages.length}`);
  if (data.metrics) {
    console.log(`Metrics:    ${JSON.stringify(data.metrics)}`);
  }
  console.log(HEAVY);

  for (let i = 0; i < selected.length; i++) {
    const stage = selected[i];
    const realIdx = stepFilter !== null ? stepFilter : i;
    console.log(`\n[Step ${realIdx}] kind=${stage.kind ?? "?"} stageId=${stage.stageId ?? "?"}`);
    console.log(`  startedAt=${fmtTime(stage.startedAt)} latencyMs=${stage.latencyMs ?? "?"}`);
    const m = stage.model;
    if (!m) {
      console.log("  (no model call)");
      continue;
    }
    console.log(SEP);
    console.log(`  model.modelType=${m.modelType ?? "?"}  provider=${m.provider ?? "?"}  modelName=${m.modelName ?? "(none)"}`);
    if (m.purpose || m.actionType) {
      console.log(`  purpose=${m.purpose ?? "(none)"}  actionType=${m.actionType ?? "(none)"}`);
    }
    if (m.usage) {
      console.log(`  usage=${JSON.stringify(m.usage)}`);
    }
    const messages = Array.isArray(m.messages) ? m.messages : [];
    for (let mi = 0; mi < messages.length; mi++) {
      const msg = messages[mi];
      const content =
        typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
      console.log(`\n  --- message[${mi}] role=${msg.role} (${content.length} chars) ---`);
      console.log(truncate(content, 4000, full).split("\n").map((l) => `    ${l}`).join("\n"));
    }
    if (typeof m.prompt === "string" && m.prompt.length > 0 && messages.length === 0) {
      console.log(`\n  --- raw prompt (${m.prompt.length} chars) ---`);
      console.log(truncate(m.prompt, 4000, full).split("\n").map((l) => `    ${l}`).join("\n"));
    }
    const respText =
      typeof m.response === "string" ? m.response : JSON.stringify(m.response, null, 2);
    console.log(`\n  --- response (${respText.length} chars) ---`);
    console.log(truncate(respText, 4000, full).split("\n").map((l) => `    ${l}`).join("\n"));
    const tcs = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    if (tcs.length > 0) {
      console.log(`\n  --- tool calls (${tcs.length}) ---`);
      for (const tc of tcs) {
        console.log(`    • ${tc.name ?? "(unnamed)"} id=${tc.id ?? "?"}`);
        const argsJson = JSON.stringify(tc.args ?? {}, null, 2);
        console.log(truncate(argsJson, 2000, full).split("\n").map((l) => `      ${l}`).join("\n"));
      }
    }
  }
  return 0;
}

function cmdCompactionDiff(args) {
  const dir = args.dir ?? defaultTrajectoryDir();
  const id = args.positional[0];
  if (!id) {
    console.error("Usage: inspect-trajectory.mjs compaction-diff <trajectoryId> [--step N] [--call N]");
    return 2;
  }
  const found = loadTrajectoryById(dir, id);
  if (!found) {
    console.error(`Trajectory not found: ${id}`);
    return 1;
  }
  const { data } = found;
  const stages = Array.isArray(data.stages) ? data.stages : [];
  const stepIdx = args.step !== undefined ? Number(args.step) : 0;
  const stage = stages[stepIdx];
  if (!stage || !stage.model) {
    console.error(`No model call at step ${stepIdx}`);
    return 1;
  }
  const original = assembledPromptFor(stage.model);
  if (!original) {
    console.error(`Step ${stepIdx} has no prompt to compact`);
    return 1;
  }
  const compacted = compactModelPrompt(original);
  const origTokens = approxTokens(original);
  const compTokens = approxTokens(compacted);
  const reduction =
    origTokens > 0 ? ((origTokens - compTokens) / origTokens) * 100 : 0;

  console.log(HEAVY);
  console.log(`Compaction diff: ${data.trajectoryId} step=${stepIdx}`);
  console.log(`Original:  ${original.length} chars  ~${origTokens} tokens`);
  console.log(`Compacted: ${compacted.length} chars  ~${compTokens} tokens`);
  console.log(`Reduction: ${reduction.toFixed(1)}%`);
  console.log(HEAVY);
  if (original === compacted) {
    console.log("(no changes — no compaction patterns matched)");
    return 0;
  }
  console.log(lineDiff(original, compacted));
  return 0;
}

function cmdStats(args) {
  const dir = args.dir ?? defaultTrajectoryDir();
  const id = args.positional[0];
  if (!id) {
    console.error("Usage: inspect-trajectory.mjs stats <trajectoryId>");
    return 2;
  }
  const found = loadTrajectoryById(dir, id);
  if (!found) {
    console.error(`Trajectory not found: ${id}`);
    return 1;
  }
  const stats = aggregateStats(found.data);
  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(stats)}\n`);
    return 0;
  }
  console.log(HEAVY);
  console.log(`Stats: ${found.data.trajectoryId}`);
  console.log(HEAVY);
  console.log(`  model calls:           ${stats.modelCalls}`);
  console.log(`  prompt tokens:         ${stats.promptTokens}`);
  console.log(`  completion tokens:     ${stats.completionTokens}`);
  console.log(`  cache read tokens:     ${stats.cacheReadTokens}`);
  console.log(`  cache creation tokens: ${stats.cacheCreationTokens}`);
  console.log(`  total tokens:          ${stats.totalTokens}`);
  console.log(`  tool calls:            ${stats.toolCalls}`);
  console.log(`  avg latency (ms):      ${stats.avgLatencyMs.toFixed(1)}`);
  console.log(`  longest prompt chars:  ${stats.longestPromptChars}`);
  console.log(`  longest response chars:${stats.longestResponseChars}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { positional: [], format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") out.full = true;
    else if (a === "--source") out.source = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--step") out.step = argv[++i];
    else if (a === "--call") out.call = argv[++i];
    else if (a === "--format") out.format = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else out.positional.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/inspect-trajectory.mjs <subcommand> [options]

Subcommands:
  list [--source X] [--limit N] [--format text|json] [--dir <path>]
      List recorded trajectories (most recent first).

  show <trajectoryId> [--step N] [--format text|json] [--full] [--dir <path>]
      Dump every llmCall in a trajectory: model, prompt messages, response,
      tool calls. Truncates long fields unless --full is set. JSON mode emits
      one ndjson record per stage.

  compaction-diff <trajectoryId> [--step N] [--dir <path>]
      Re-run compactModelPrompt on the recorded prompt for the given step
      and print a unified-style line diff plus token reduction estimate
      (4-chars-per-token heuristic).

  stats <trajectoryId> [--format text|json] [--dir <path>]
      Aggregate stats: token totals, tool-call count, avg latency, longest
      prompt/response.

Default trajectory directory: ${defaultTrajectoryDir()}
`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function main(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const args = parseArgs(rest);
  if (args.help) {
    printHelp();
    return 0;
  }
  switch (sub) {
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "compaction-diff":
      return cmdCompactionDiff(args);
    case "stats":
      return cmdStats(args);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      return 2;
  }
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(`file://${path.resolve(entry)}`);
    return url.href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    },
  );
}
