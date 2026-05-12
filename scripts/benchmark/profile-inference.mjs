#!/usr/bin/env node
/**
 * profile-inference.mjs — on-device chat agent profiling harness.
 *
 * Walks a (model × kvCacheConfig × dflashConfig × prompt) matrix against a
 * running agent API and writes a structured JSON + Markdown report. Designed
 * to be run against either:
 *   - a host-side dev server (`bun run dev`), or
 *   - the cuttlefish AOSP image once Agent E lands the chat round-trip fix.
 *
 * The harness only talks to the public HTTP surface so it works against
 * any deployment that exposes /api/local-inference/* + /api/conversations.
 *
 * Usage:
 *   node scripts/benchmark/profile-inference.mjs \
 *     [--target http://localhost:31337] \
 *     [--config scripts/benchmark/configs/host-cpu.json] \
 *     [--token <api token>] \
 *     [--out reports/porting/<date>] \
 *     [--non-streaming] \
 *     [--load-timeout-ms 120000] \
 *     [--request-timeout-ms 180000] \
 *     [--label <run-label>]
 *
 * Exit codes:
 *   0 — every run either succeeded OR captured a structured failure
 *   1 — harness itself crashed (config load, network, fs write); a per-run
 *       inference failure is NOT a harness failure.
 *
 * API contract (verified against eliza/packages/app-core/src/api/* +
 * eliza/packages/agent/src/api/conversation-routes.ts on 2026-05-09):
 *
 *   POST   /api/local-inference/active   { modelId }            -> ActiveModelState
 *   DELETE /api/local-inference/active                          -> ActiveModelState
 *   POST   /api/conversations            { title? }             -> { conversation }
 *   POST   /api/conversations/:id/messages          { text, ... }
 *                                                                -> { text, agentName }
 *   POST   /api/conversations/:id/messages/stream   { text, ... }
 *                                                                -> SSE: token / done
 *   DELETE /api/conversations/:id
 *   GET    /api/health
 *
 * Per-call cache type / drafter pairing override:
 *   POST /api/local-inference/active accepts a per-load `overrides` block
 *   (contextSize, cacheTypeK, cacheTypeV, gpuLayers, kvOffload,
 *   flashAttention, mmap, mlock). The harness threads kvCacheConfig.k /
 *   .v values from the matrix into that block so a real KV-cache codec
 *   choice lands at load time instead of silently falling back to fp16.
 *
 *   Drafter pairing is still read from the catalog entry's
 *   `runtime.dflash.drafterModelId` block — the load endpoint does not
 *   yet accept a per-load drafter override. dflashConfig entries whose
 *   `drafter` differs from the catalog default are recorded as a
 *   `configGaps[]` entry and run with the catalog drafter.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

// ─── arg parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    target: "http://localhost:31337",
    config: null,
    token: process.env.ELIZA_API_TOKEN ?? process.env.ELIZA_API_TOKEN ?? null,
    out: null,
    streaming: true,
    loadTimeoutMs: 120_000,
    requestTimeoutMs: 180_000,
    label: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return v;
    };
    switch (arg) {
      case "--target":
        out.target = next();
        break;
      case "--config":
        out.config = next();
        break;
      case "--token":
        out.token = next();
        break;
      case "--out":
        out.out = next();
        break;
      case "--non-streaming":
        out.streaming = false;
        break;
      case "--load-timeout-ms":
        out.loadTimeoutMs = Number(next());
        break;
      case "--request-timeout-ms":
        out.requestTimeoutMs = Number(next());
        break;
      case "--label":
        out.label = next();
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }
  if (!out.config) {
    out.config = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "configs",
      pickDefaultConfigName(),
    );
  }
  return out;
}

/**
 * Auto-pick a config file when the operator doesn't pass `--config`.
 * Runs purely against host hints — `process.platform`, `process.arch`,
 * and the `CUDA_VISIBLE_DEVICES` env var. This mirrors `chooseBackend`
 * in `plugin-local-embedding`, but kept inline so the harness has zero
 * runtime dependencies on Eliza source.
 */
function pickDefaultConfigName() {
  const cuda = process.env.CUDA_VISIBLE_DEVICES?.trim();
  if (cuda && cuda !== "" && cuda !== "-1") return "host-cuda.json";
  if (process.platform === "darwin") return "host-metal.json";
  if (process.platform === "linux" || process.platform === "win32") {
    return "host-cpu.json";
  }
  return "host-cpu.json";
}

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/benchmark/profile-inference.mjs [options]

Options:
  --target <url>            Agent API base (default http://localhost:31337)
  --config <path>           Profiling matrix JSON
                            (auto-picked by host: configs/host-{cpu,metal,cuda}.json)
  --token <str>             API token; also reads ELIZA_API_TOKEN /
                            ELIZA_API_TOKEN from env
  --out <dir>               Output directory
                            (default reports/porting/<YYYY-MM-DD>)
  --non-streaming           Skip SSE first-token timing; use sync endpoint only
  --load-timeout-ms <n>     Per-load timeout (default 120000)
  --request-timeout-ms <n>  Per-message timeout (default 180000)
  --label <str>             Optional run label embedded in the report
`,
  );
}

// ─── config validation ──────────────────────────────────────────────

function validateConfig(cfg, configPath) {
  if (!cfg || typeof cfg !== "object") {
    throw new Error(`Config ${configPath} is not an object`);
  }
  const fields = [
    ["models", "array"],
    ["kvCacheConfigs", "array"],
    ["dflashConfigs", "array"],
    ["prompts", "array"],
    ["iterations", "number"],
    ["warmupIterations", "number"],
  ];
  for (const [key, kind] of fields) {
    const value = cfg[key];
    if (kind === "array") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`Config field "${key}" must be a non-empty array`);
      }
    } else if (kind === "number") {
      if (typeof value !== "number" || value < 0 || !Number.isFinite(value)) {
        throw new Error(`Config field "${key}" must be a non-negative number`);
      }
    }
  }
  if (cfg.iterations < 1) {
    throw new Error(`Config field "iterations" must be >= 1`);
  }
  for (const m of cfg.models) {
    if (typeof m !== "string" || m.length === 0) {
      throw new Error(`models[] entries must be non-empty strings`);
    }
  }
  for (const k of cfg.kvCacheConfigs) {
    if (
      !k ||
      typeof k.name !== "string" ||
      typeof k.k !== "string" ||
      typeof k.v !== "string"
    ) {
      throw new Error(`kvCacheConfigs[] entries must have {name, k, v}`);
    }
  }
  for (const d of cfg.dflashConfigs) {
    if (!d || typeof d.name !== "string") {
      throw new Error(`dflashConfigs[] entries must have {name, drafter?}`);
    }
    if (
      d.drafter !== null &&
      d.drafter !== undefined &&
      typeof d.drafter !== "string"
    ) {
      throw new Error(`dflashConfigs[].drafter must be string|null`);
    }
  }
  for (const p of cfg.prompts) {
    if (
      !p ||
      typeof p.id !== "string" ||
      typeof p.text !== "string" ||
      typeof p.maxTokens !== "number"
    ) {
      throw new Error(`prompts[] entries must have {id, text, maxTokens}`);
    }
  }
}

// ─── stats helpers ──────────────────────────────────────────────────

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  // Linear-interpolation percentile (matches numpy default, R type-7).
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function summarize(values) {
  if (values.length === 0) {
    return { count: 0, median: null, p95: null, min: null, max: null };
  }
  return {
    count: values.length,
    median: median(values),
    p95: percentile(values, 95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

// ─── HTTP client ────────────────────────────────────────────────────

class ApiClient {
  constructor({ baseUrl, token, requestTimeoutMs }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  authHeaders() {
    if (!this.token) return {};
    // Server accepts Authorization: Bearer, X-API-Token, X-API-Key.
    return {
      Authorization: `Bearer ${this.token}`,
      "X-API-Token": this.token,
    };
  }

  async json(method, pathname, body, { timeoutMs } = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.requestTimeoutMs,
    );
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave parsed as null; raw text exposed via Error
        }
      }
      if (!res.ok) {
        const err = new Error(
          `HTTP ${res.status} ${res.statusText} for ${method} ${pathname}: ${text.slice(0, 400)}`,
        );
        err.status = res.status;
        err.body = parsed ?? text;
        throw err;
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stream a chat message and return a structured timing record.
   * Returns:
   *   {
   *     firstTokenLatencyMs: number,
   *     totalLatencyMs: number,
   *     fullText: string,
   *     agentName: string|null,
   *     done: boolean,
   *     error: string|null,
   *   }
   */
  async streamChat(conversationId, body, { timeoutMs } = {}) {
    const url = `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.requestTimeoutMs,
    );
    const sentAt = performance.now();
    let firstTokenAt = null;
    let fullText = "";
    let agentName = null;
    let done = false;
    let streamError = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(
          `HTTP ${res.status} ${res.statusText} on stream: ${text.slice(0, 400)}`,
        );
        err.status = res.status;
        throw err;
      }
      if (!res.body) {
        throw new Error("Stream response has no body");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE event delimiter is "\n\n"
        let sepIndex = buffer.indexOf("\n\n");
        while (sepIndex >= 0) {
          const event = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          sepIndex = buffer.indexOf("\n\n");
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt.type === "token") {
              if (firstTokenAt === null) firstTokenAt = performance.now();
              if (typeof evt.fullText === "string") {
                fullText = evt.fullText;
              } else if (typeof evt.text === "string") {
                fullText += evt.text;
              }
            } else if (evt.type === "done") {
              done = true;
              if (typeof evt.fullText === "string") fullText = evt.fullText;
              if (typeof evt.agentName === "string") agentName = evt.agentName;
            } else if (evt.type === "error") {
              streamError =
                typeof evt.message === "string" ? evt.message : "stream error";
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
    const completedAt = performance.now();
    return {
      firstTokenLatencyMs: firstTokenAt === null ? null : firstTokenAt - sentAt,
      totalLatencyMs: completedAt - sentAt,
      fullText,
      agentName,
      done,
      error: streamError,
    };
  }
}

// ─── token estimator ────────────────────────────────────────────────

/**
 * Crude token count estimator. The agent's chat endpoints don't return
 * token counts on the streaming surface, so we approximate at ~4 chars
 * per token, which is the conventional GPT/Llama upper bound for
 * English. Recorded as `estimatedTokens` so it isn't confused with a
 * canonical count from the model.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

// ─── core run loop ──────────────────────────────────────────────────

async function loadModel(client, modelId, { loadTimeoutMs, overrides }) {
  const startedAt = performance.now();
  const body = { modelId };
  if (overrides && Object.keys(overrides).length > 0) {
    body.overrides = overrides;
  }
  const result = await client.json(
    "POST",
    "/api/local-inference/active",
    body,
    { timeoutMs: loadTimeoutMs },
  );
  const elapsed = performance.now() - startedAt;
  const status = result?.status ?? "unknown";
  if (status === "error") {
    const message = result?.error ?? "unknown load error";
    const err = new Error(`Model ${modelId} load reported error: ${message}`);
    err.loadResult = result;
    throw err;
  }
  return { result, loadMs: elapsed };
}

/**
 * Map a kvCacheConfig entry from the matrix into the `overrides` body
 * accepted by POST /api/local-inference/active. `null` / empty entries
 * skip the field so the catalog default applies.
 */
function buildLoadOverrides(kvCache) {
  const overrides = {};
  if (kvCache && typeof kvCache.k === "string" && kvCache.k.length > 0) {
    overrides.cacheTypeK = kvCache.k;
  }
  if (kvCache && typeof kvCache.v === "string" && kvCache.v.length > 0) {
    overrides.cacheTypeV = kvCache.v;
  }
  if (kvCache && typeof kvCache.contextSize === "number") {
    overrides.contextSize = kvCache.contextSize;
  }
  if (kvCache && typeof kvCache.gpuLayers === "number") {
    overrides.gpuLayers = kvCache.gpuLayers;
  }
  if (kvCache && typeof kvCache.flashAttention === "boolean") {
    overrides.flashAttention = kvCache.flashAttention;
  }
  return overrides;
}

async function unloadModel(client, { loadTimeoutMs }) {
  try {
    await client.json("DELETE", "/api/local-inference/active", undefined, {
      timeoutMs: loadTimeoutMs,
    });
  } catch (err) {
    // Unload failures shouldn't abort the matrix; surface in stderr only.
    process.stderr.write(
      `[profile-inference] WARN: unload failed: ${err.message}\n`,
    );
  }
}

async function createConversation(client, title) {
  const body = await client.json("POST", "/api/conversations", { title });
  const conversation = body?.conversation;
  if (!conversation || typeof conversation.id !== "string") {
    throw new Error("Create-conversation response missing conversation.id");
  }
  return conversation;
}

async function deleteConversation(client, id) {
  try {
    await client.json("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
  } catch (err) {
    process.stderr.write(
      `[profile-inference] WARN: delete conversation ${id} failed: ${err.message}\n`,
    );
  }
}

async function runIteration(client, { conversationId, prompt, streaming }) {
  const body = {
    text: prompt.text,
    metadata: { profileInference: true, promptId: prompt.id },
  };
  if (streaming) {
    const r = await client.streamChat(conversationId, body);
    return {
      mode: "stream",
      firstTokenLatencyMs: r.firstTokenLatencyMs,
      totalLatencyMs: r.totalLatencyMs,
      estimatedTokens: estimateTokens(r.fullText),
      tokensPerSecond:
        r.totalLatencyMs > 0
          ? (estimateTokens(r.fullText) / r.totalLatencyMs) * 1000
          : null,
      fullText: r.fullText,
      done: r.done,
      streamError: r.error,
    };
  }
  const sentAt = performance.now();
  const res = await client.json(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    body,
  );
  const elapsed = performance.now() - sentAt;
  const text = typeof res?.text === "string" ? res.text : "";
  const tokens = estimateTokens(text);
  return {
    mode: "sync",
    firstTokenLatencyMs: null,
    totalLatencyMs: elapsed,
    estimatedTokens: tokens,
    tokensPerSecond: elapsed > 0 ? (tokens / elapsed) * 1000 : null,
    fullText: text,
    done: true,
    streamError: null,
  };
}

function combinationKey({ model, kvCache, dflash, prompt }) {
  return `${model}__${kvCache.name}__${dflash.name}__${prompt.id}`;
}

async function runOneCombination({
  client,
  combination,
  iterations,
  warmupIterations,
  streaming,
  loadTimeoutMs,
}) {
  const { model, kvCache, dflash, prompt } = combination;
  const key = combinationKey(combination);
  const record = {
    key,
    model,
    kvCache,
    dflash,
    prompt: { id: prompt.id, maxTokens: prompt.maxTokens },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    loadMs: null,
    loadResult: null,
    configGaps: [],
    appliedOverrides: null,
    warmupIterations: [],
    iterations: [],
    summary: null,
    error: null,
  };

  // KV-cache overrides are now first-class on POST /api/local-inference/active
  // (see services/local-inference/active-model.ts:resolveLocalInferenceLoadArgs
  // and api/local-inference-compat-routes.ts). The harness sends them
  // through the load body, so kvCache.k / .v take effect at load time
  // instead of being silently ignored. Drafter pairing remains a
  // catalog-only knob — record that as the only remaining gap.
  if (dflash.drafter) {
    record.configGaps.push({
      kind: "drafter-override-not-supported",
      requested: { drafter: dflash.drafter },
      workaround:
        "Drafter pairing is read from the catalog entry's runtime.dflash.drafterModelId. Edit the catalog or use a model whose runtime block already references the desired drafter.",
    });
  }

  const loadOverrides = buildLoadOverrides(kvCache);
  if (Object.keys(loadOverrides).length > 0) {
    record.appliedOverrides = loadOverrides;
  }

  let conversation = null;
  try {
    const loaded = await loadModel(client, model, {
      loadTimeoutMs,
      overrides: loadOverrides,
    });
    record.loadMs = loaded.loadMs;
    record.loadResult = loaded.result;
    conversation = await createConversation(
      client,
      `profile-${key}-${Date.now()}`,
    );
    for (let i = 0; i < warmupIterations; i += 1) {
      try {
        const w = await runIteration(client, {
          conversationId: conversation.id,
          prompt,
          streaming,
        });
        record.warmupIterations.push({ index: i, ...w });
      } catch (err) {
        record.warmupIterations.push({ index: i, error: err.message });
      }
    }
    for (let i = 0; i < iterations; i += 1) {
      try {
        const result = await runIteration(client, {
          conversationId: conversation.id,
          prompt,
          streaming,
        });
        record.iterations.push({ index: i, ...result });
      } catch (err) {
        record.iterations.push({ index: i, error: err.message });
      }
    }
    const successful = record.iterations.filter((it) => !it.error);
    const totals = successful.map((it) => it.totalLatencyMs);
    const firstTokens = successful
      .map((it) => it.firstTokenLatencyMs)
      .filter((v) => typeof v === "number");
    const tps = successful
      .map((it) => it.tokensPerSecond)
      .filter((v) => typeof v === "number");
    const tokenCounts = successful.map((it) => it.estimatedTokens);
    record.summary = {
      successCount: successful.length,
      errorCount: record.iterations.length - successful.length,
      totalLatencyMs: summarize(totals),
      firstTokenLatencyMs: summarize(firstTokens),
      tokensPerSecond: summarize(tps),
      estimatedTokens: summarize(tokenCounts),
    };
  } catch (err) {
    record.error = {
      message: err.message,
      stack: err.stack ?? null,
      loadResult: err.loadResult ?? null,
    };
  } finally {
    if (conversation) await deleteConversation(client, conversation.id);
    await unloadModel(client, { loadTimeoutMs });
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

// ─── reporting ──────────────────────────────────────────────────────

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function buildMarkdownReport({
  runs,
  args,
  config,
  target,
  startedAt,
  finishedAt,
}) {
  const lines = [];
  lines.push("# On-device inference profile");
  lines.push("");
  lines.push(`- **Generated:** ${finishedAt}`);
  lines.push(`- **Started:** ${startedAt}`);
  lines.push(`- **Target:** \`${target}\``);
  lines.push(`- **Streaming mode:** ${args.streaming ? "yes" : "no"}`);
  if (args.label) lines.push(`- **Label:** ${args.label}`);
  lines.push(`- **Config:** \`${args.config}\``);
  lines.push(
    `- **Iterations per combo:** ${config.iterations} (+ ${config.warmupIterations} warmup)`,
  );
  lines.push("");
  lines.push("## Summary table");
  lines.push("");
  lines.push(
    "Latencies are milliseconds. Tokens/s is estimated from response length (~4 chars/token).",
  );
  lines.push("");
  lines.push(
    "| Model | KV cache | DFlash | Prompt | Load (ms) | First-token median | Total median | Total p95 | tok/s median | OK / total | Notes |",
  );
  lines.push("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const run of runs) {
    const s = run.summary;
    const notes = [];
    if (run.error) notes.push(`error: ${run.error.message}`);
    if (run.configGaps.length > 0) {
      notes.push(`gaps: ${run.configGaps.map((g) => g.kind).join(", ")}`);
    }
    lines.push(
      `| ${run.model} | ${run.kvCache.name} | ${run.dflash.name} | ${run.prompt.id} | ${formatNumber(run.loadMs, 0)} | ${
        s ? formatNumber(s.firstTokenLatencyMs.median, 0) : "—"
      } | ${s ? formatNumber(s.totalLatencyMs.median, 0) : "—"} | ${
        s ? formatNumber(s.totalLatencyMs.p95, 0) : "—"
      } | ${s ? formatNumber(s.tokensPerSecond.median, 1) : "—"} | ${
        s ? `${s.successCount} / ${s.successCount + s.errorCount}` : "0 / 0"
      } | ${notes.join("; ") || "—"} |`,
    );
  }
  lines.push("");
  lines.push("## Config gaps");
  lines.push("");
  const gapKinds = new Map();
  for (const run of runs) {
    for (const gap of run.configGaps) {
      const list = gapKinds.get(gap.kind) ?? [];
      list.push(run.key);
      gapKinds.set(gap.kind, list);
    }
  }
  if (gapKinds.size === 0) {
    lines.push(
      "None — every kvCache/dflash combination matched the catalog defaults.",
    );
  } else {
    for (const [kind, keys] of gapKinds) {
      lines.push(
        `- **${kind}**: ${keys.length} runs affected. Workaround documented in profile.json.`,
      );
    }
  }
  lines.push("");
  lines.push("## Errors");
  lines.push("");
  const failed = runs.filter((r) => r.error);
  if (failed.length === 0) {
    lines.push("No combination errored at the harness level.");
  } else {
    for (const run of failed) {
      lines.push(`- \`${run.key}\`: ${run.error.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configRaw = await readFile(args.config, "utf8");
  const config = JSON.parse(configRaw);
  validateConfig(config, args.config);

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(args.out ?? `reports/porting/${today}`);
  await mkdir(outDir, { recursive: true });

  const client = new ApiClient({
    baseUrl: args.target,
    token: args.token,
    requestTimeoutMs: args.requestTimeoutMs,
  });

  // Health probe before starting the matrix — fail fast if the target
  // isn't actually a running agent.
  try {
    await client.json("GET", "/api/health", undefined, { timeoutMs: 10_000 });
  } catch (err) {
    process.stderr.write(
      `[profile-inference] FATAL: health probe failed against ${args.target}: ${err.message}\n`,
    );
    process.exit(1);
  }

  const combinations = [];
  for (const model of config.models) {
    for (const kvCache of config.kvCacheConfigs) {
      for (const dflash of config.dflashConfigs) {
        for (const prompt of config.prompts) {
          combinations.push({ model, kvCache, dflash, prompt });
        }
      }
    }
  }

  const startedAt = new Date().toISOString();
  process.stdout.write(
    `[profile-inference] Running ${combinations.length} combinations against ${args.target}\n`,
  );

  const runs = [];
  for (let i = 0; i < combinations.length; i += 1) {
    const combo = combinations[i];
    const key = combinationKey(combo);
    process.stdout.write(
      `[profile-inference] (${i + 1}/${combinations.length}) ${key}\n`,
    );
    const run = await runOneCombination({
      client,
      combination: combo,
      iterations: config.iterations,
      warmupIterations: config.warmupIterations,
      streaming: args.streaming,
      loadTimeoutMs: args.loadTimeoutMs,
    });
    runs.push(run);
  }

  const finishedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    target: args.target,
    label: args.label,
    streaming: args.streaming,
    configPath: args.config,
    startedAt,
    finishedAt,
    config,
    runs,
  };

  const jsonPath = path.join(outDir, "profile.json");
  const mdPath = path.join(outDir, "profile.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(
    mdPath,
    buildMarkdownReport({
      runs,
      args,
      config,
      target: args.target,
      startedAt,
      finishedAt,
    }),
    "utf8",
  );

  process.stdout.write(
    `[profile-inference] Wrote ${jsonPath} (${runs.length} runs)\n`,
  );
  process.stdout.write(`[profile-inference] Wrote ${mdPath}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `[profile-inference] FATAL: ${err.stack ?? err.message ?? String(err)}\n`,
  );
  process.exit(1);
});
