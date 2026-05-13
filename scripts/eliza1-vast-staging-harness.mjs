#!/usr/bin/env node
/**
 * Live Vast staging evidence collector for Eliza-1 release gates.
 *
 * This script is intentionally operational: it talks to an OpenAI-compatible
 * staging endpoint and writes JSON evidence under reports/eliza1-release-gates.
 * It never treats missing measurements as pass evidence.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const DEFAULT_EVIDENCE_DIR = path.join(
  REPO_ROOT,
  "reports",
  "eliza1-release-gates",
);

const DEFAULT_MODEL = "vast/eliza-1-4b";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.VAST_STAGING_BASE_URL?.trim() || "",
    apiKey: process.env.VAST_STAGING_API_KEY?.trim() || "not-required",
    model: process.env.VAST_STAGING_MODEL?.trim() || DEFAULT_MODEL,
    instanceId: process.env.VAST_STAGING_INSTANCE_ID?.trim() || "unknown",
    evidenceDir:
      process.env.ELIZA1_EVIDENCE_DIR?.trim() || DEFAULT_EVIDENCE_DIR,
    smokeTier: process.env.ELIZA1_SMOKE_TIER?.trim() || "4b",
    burstRequests: Number.parseInt(
      process.env.ELIZA1_BURST_REQUESTS || "12",
      10,
    ),
    burstConcurrency: Number.parseInt(
      process.env.ELIZA1_BURST_CONCURRENCY || "4",
      10,
    ),
    coldStartMs:
      process.env.ELIZA1_COLD_START_MS === undefined
        ? null
        : Number.parseInt(process.env.ELIZA1_COLD_START_MS, 10),
    soakMs: Number.parseInt(process.env.ELIZA1_SOAK_MS || "3600000", 10),
    soakIntervalMs: Number.parseInt(
      process.env.ELIZA1_SOAK_INTERVAL_MS || "30000",
      10,
    ),
    metricsUrl: process.env.ELIZA1_METRICS_URL?.trim() || "",
    rssCommand: process.env.ELIZA1_RSS_COMMAND?.trim() || "",
    failoverFallbackUrl: process.env.ELIZA1_FAILOVER_FALLBACK_URL?.trim() || "",
    failoverKillCommand: process.env.ELIZA1_FAILOVER_KILL_COMMAND?.trim() || "",
    failoverKilledNode: process.env.ELIZA1_FAILOVER_KILLED_NODE?.trim() || "",
    runLive: true,
    runSmoke: true,
    runParity: true,
    runBurst: true,
    runSoak: false,
    runFailover: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--api-key") args.apiKey = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--instance-id") args.instanceId = next();
    else if (arg === "--evidence-dir") args.evidenceDir = path.resolve(next());
    else if (arg === "--smoke-tier") args.smokeTier = next().toLowerCase();
    else if (arg === "--burst-requests")
      args.burstRequests = Number.parseInt(next(), 10);
    else if (arg === "--burst-concurrency")
      args.burstConcurrency = Number.parseInt(next(), 10);
    else if (arg === "--cold-start-ms")
      args.coldStartMs = Number.parseInt(next(), 10);
    else if (arg === "--soak-ms") args.soakMs = Number.parseInt(next(), 10);
    else if (arg === "--soak-interval-ms")
      args.soakIntervalMs = Number.parseInt(next(), 10);
    else if (arg === "--metrics-url") args.metricsUrl = next();
    else if (arg === "--rss-command") args.rssCommand = next();
    else if (arg === "--failover-fallback-url")
      args.failoverFallbackUrl = next();
    else if (arg === "--failover-kill-command")
      args.failoverKillCommand = next();
    else if (arg === "--failover-killed-node") args.failoverKilledNode = next();
    else if (arg === "--only") {
      const selected = new Set(
        next()
          .split(",")
          .map((value) => value.trim()),
      );
      args.runLive = selected.has("live");
      args.runSmoke = selected.has("smoke");
      args.runParity = selected.has("parity");
      args.runBurst = selected.has("burst");
      args.runSoak = selected.has("soak");
      args.runFailover = selected.has("failover");
    } else if (arg === "--include-soak") args.runSoak = true;
    else if (arg === "--include-failover") args.runFailover = true;
    else if (arg === "--skip-live") args.runLive = false;
    else if (arg === "--skip-smoke") args.runSmoke = false;
    else if (arg === "--skip-parity") args.runParity = false;
    else if (arg === "--skip-burst") args.runBurst = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/eliza1-vast-staging-harness.mjs --base-url URL [options]",
          "",
          "Writes release evidence for live, smoke, parity, burst, optional soak, and optional failover gates.",
          "Required env alternative: VAST_STAGING_BASE_URL=http://host:port",
          "",
          "Examples:",
          "  node scripts/eliza1-vast-staging-harness.mjs --base-url http://ssh3.vast.ai:11983",
          "  node scripts/eliza1-vast-staging-harness.mjs --only soak --include-soak --soak-ms 3600000",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.baseUrl)
    throw new Error("missing --base-url or VAST_STAGING_BASE_URL");
  if (!Number.isFinite(args.burstRequests) || args.burstRequests < 1) {
    throw new Error("--burst-requests must be a positive integer");
  }
  if (!Number.isFinite(args.burstConcurrency) || args.burstConcurrency < 1) {
    throw new Error("--burst-concurrency must be a positive integer");
  }
  if (args.coldStartMs !== null && !Number.isFinite(args.coldStartMs)) {
    throw new Error("--cold-start-ms must be an integer when set");
  }
  if (!["2b", "9b", "27b"].includes(args.smokeTier)) {
    throw new Error("--smoke-tier must be one of 2b, 9b, or 27b");
  }
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  if (args.metricsUrl) args.metricsUrl = args.metricsUrl.replace(/\/+$/, "");
  return args;
}

function timestampForFile() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function gateFileName(gate) {
  return `${gate}-${timestampForFile()}.json`;
}

function writeEvidence(args, gate, evidence) {
  fs.mkdirSync(args.evidenceDir, { recursive: true });
  const file = path.join(args.evidenceDir, gateFileName(gate));
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `[eliza1:harness] wrote ${path.relative(REPO_ROOT, file)} (${evidence.status})`,
  );
  return file;
}

function authHeaders(args) {
  return {
    Authorization: `Bearer ${args.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchText(url, options = {}) {
  const started = performance.now();
  const res = await fetch(url, options);
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text,
    latencyMs: Math.round(performance.now() - started),
  };
}

async function listModels(args, baseUrl = args.baseUrl) {
  const result = await fetchText(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${args.apiKey}` },
  });
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch {
    // Keep json null; caller records the status and text snippet.
  }
  const ids = Array.isArray(json?.data)
    ? json.data.map((model) => String(model.id ?? ""))
    : [];
  return { ...result, json, ids };
}

function parseToolCallsFromMessage(message) {
  if (!message || typeof message !== "object") return [];
  if (Array.isArray(message.tool_calls)) return message.tool_calls;
  return [];
}

function mergeStreamingToolCall(acc, delta) {
  for (const call of delta.tool_calls || []) {
    const index = Number.isInteger(call.index) ? call.index : acc.length;
    acc[index] ??= {
      id: call.id || "",
      type: call.type || "function",
      function: { name: "", arguments: "" },
    };
    if (call.id) acc[index].id = call.id;
    if (call.type) acc[index].type = call.type;
    if (call.function?.name) {
      const current = acc[index].function.name;
      const next = call.function.name;
      acc[index].function.name =
        !current || next === current || current.endsWith(next)
          ? next
          : `${current}${next}`;
    }
    if (call.function?.arguments) {
      acc[index].function.arguments += call.function.arguments;
    }
  }
}

async function chatCompletion(args, body, baseUrl = args.baseUrl) {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(args),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const latencyMs = Math.round(performance.now() - started);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep raw text for diagnostics.
  }
  const message = json?.choices?.[0]?.message;
  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
    latencyMs,
    content: String(message?.content ?? ""),
    toolCalls: parseToolCallsFromMessage(message),
    usage: json?.usage ?? null,
  };
}

async function streamChatCompletion(args, body, baseUrl = args.baseUrl) {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(args),
    body: JSON.stringify({ ...body, stream: true }),
  });
  const firstByteAt = performance.now();
  if (!res.ok || !res.body) {
    const text = await res.text();
    return {
      ok: false,
      status: res.status,
      text,
      firstByteMs: Math.round(firstByteAt - started),
      latencyMs: Math.round(performance.now() - started),
      content: "",
      toolCalls: [],
      usage: null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage = null;
  const toolCalls = [];
  const events = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;
      let json = null;
      try {
        json = JSON.parse(payload);
      } catch {
        events.push({ parseError: payload.slice(0, 200) });
        continue;
      }
      events.push(json);
      const delta = json.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      mergeStreamingToolCall(toolCalls, delta);
      if (json.usage) usage = json.usage;
    }
  }

  return {
    ok: true,
    status: res.status,
    firstByteMs: Math.round(firstByteAt - started),
    latencyMs: Math.round(performance.now() - started),
    content,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    eventCount: events.length,
  };
}

function usageSimilar(left, right) {
  if (!left || !right) return false;
  const fields = ["prompt_tokens", "completion_tokens", "total_tokens"];
  return fields.every((field) => {
    const a = Number(left[field]);
    const b = Number(right[field]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return Math.abs(a - b) <= Math.max(2, Math.ceil(Math.max(a, b) * 0.15));
  });
}

function toolCallSignature(calls) {
  return calls
    .map((call) => ({
      name: String(call.function?.name ?? ""),
      arguments: String(call.function?.arguments ?? ""),
    }))
    .filter((call) => call.name || call.arguments);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[idx];
}

async function runLive(args) {
  const models = await listModels(args);
  const smoke = await chatCompletion(args, {
    model: args.model,
    messages: [
      { role: "user", content: "Reply with exactly: eliza-vast-smoke" },
    ],
    temperature: 0,
    max_tokens: 16,
    stream: false,
  });
  const contentOk = smoke.content.toLowerCase().includes("eliza-vast-smoke");
  const evidence = {
    gate: "live_vast_staging_deploy",
    status: models.ok && smoke.ok && contentOk ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    model: args.model,
    instanceId: args.instanceId,
    modelsStatus: models.status,
    modelIds: models.ids,
    chatStatus: smoke.status,
    chatLatencyMs: smoke.latencyMs,
    usage: smoke.usage,
    summary: `Vast staging model list ${models.status}; chat ${smoke.status} in ${smoke.latencyMs}ms`,
  };
  writeEvidence(args, evidence.gate, evidence);
  return evidence;
}

async function runSmoke(args) {
  const models = await listModels(args);
  const modelLoaded =
    models.ids.length === 0 ||
    models.ids.includes(args.model) ||
    models.ids.includes(DEFAULT_MODEL);
  const generation = await chatCompletion(args, {
    model: args.model,
    messages: [
      { role: "system", content: "You are an exact-answer smoke-test model." },
      { role: "user", content: "Reply with exactly: eliza-vast-smoke" },
    ],
    temperature: 0,
    max_tokens: 16,
    stream: false,
  });
  const generationOk = generation.content
    .toLowerCase()
    .includes("eliza-vast-smoke");
  const gate = `smoke_${args.smokeTier}`;
  const evidence = {
    gate,
    status: generation.ok && modelLoaded && generationOk ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    tier: args.smokeTier,
    model: args.model,
    baseUrl: args.baseUrl,
    instanceId: args.instanceId,
    modelLoaded,
    modelIds: models.ids,
    generationOk,
    latencyMs: generation.latencyMs,
    usage: generation.usage,
    summary: `${args.smokeTier} smoke ${generation.ok && generationOk ? "passed" : "failed"} in ${generation.latencyMs}ms`,
  };
  writeEvidence(args, gate, evidence);
  return evidence;
}

async function runParity(args) {
  const request = {
    model: args.model,
    messages: [
      {
        role: "user",
        content:
          "Use the record_probe tool with code eliza-stream-parity and value 7. Do not answer in prose.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "record_probe",
          description: "Record a release gate probe.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              value: { type: "integer" },
            },
            required: ["code", "value"],
          },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "record_probe" },
    },
    temperature: 0,
    max_tokens: 96,
    stream_options: { include_usage: true },
  };
  const nonStreaming = await chatCompletion(args, {
    ...request,
    stream: false,
  });
  const streaming = await streamChatCompletion(args, request);
  const nonStreamingToolCalls = toolCallSignature(nonStreaming.toolCalls);
  const streamingToolCalls = toolCallSignature(streaming.toolCalls);
  const usageParity = usageSimilar(nonStreaming.usage, streaming.usage);
  const nameParity =
    nonStreamingToolCalls.length > 0 &&
    streamingToolCalls.length > 0 &&
    nonStreamingToolCalls[0].name === streamingToolCalls[0].name;
  const argumentParity =
    nameParity &&
    nonStreamingToolCalls[0].arguments.includes("eliza-stream-parity") &&
    streamingToolCalls[0].arguments.includes("eliza-stream-parity");

  const evidence = {
    gate: "streaming_tool_call_parity",
    status:
      nonStreaming.ok &&
      streaming.ok &&
      nameParity &&
      argumentParity &&
      usageParity
        ? "pass"
        : "fail",
    completedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    model: args.model,
    nonStreamingToolCalls,
    streamingToolCalls,
    usageParity,
    nonStreamingUsage: nonStreaming.usage,
    streamingUsage: streaming.usage,
    nonStreamingLatencyMs: nonStreaming.latencyMs,
    streamingFirstByteMs: streaming.firstByteMs,
    streamingLatencyMs: streaming.latencyMs,
    summary: `non-stream ${nonStreaming.status}; stream ${streaming.status}; tool parity ${nameParity && argumentParity}; usage parity ${usageParity}`,
  };
  writeEvidence(args, evidence.gate, evidence);
  return evidence;
}

async function runBurst(args) {
  const tasks = Array.from({ length: args.burstRequests }, (_, index) => index);
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const result = await chatCompletion(args, {
        model: args.model,
        messages: [
          {
            role: "user",
            content: `Reply with exactly: burst-${index}`,
          },
        ],
        temperature: 0,
        max_tokens: 12,
        stream: false,
      });
      const contentOk = result.content.toLowerCase().includes(`burst-${index}`);
      results.push({
        index,
        ok: result.ok && contentOk,
        status: result.status,
        latencyMs: result.latencyMs,
      });
    }
  }

  const started = performance.now();
  await Promise.all(
    Array.from(
      { length: Math.min(args.burstConcurrency, args.burstRequests) },
      () => worker(),
    ),
  );
  const durationMs = Math.round(performance.now() - started);
  const latencies = results.map((result) => result.latencyMs);
  const errors = results.filter((result) => !result.ok).length;
  const errorRate = errors / results.length;
  const burstP95Ms = percentile(latencies, 0.95);
  const evidence = {
    gate: "cold_start_burst_load",
    status:
      errorRate <= 0.05 &&
      Number.isFinite(burstP95Ms) &&
      Number.isFinite(args.coldStartMs)
        ? "pass"
        : "fail",
    completedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    model: args.model,
    coldStartMs: args.coldStartMs,
    burstRequests: args.burstRequests,
    burstConcurrency: args.burstConcurrency,
    burstP50Ms: percentile(latencies, 0.5),
    burstP95Ms,
    burstMaxMs: Math.max(...latencies),
    durationMs,
    errorRate,
    errors,
    summary: `${args.burstRequests} burst requests at concurrency ${args.burstConcurrency}; p95 ${burstP95Ms}ms; error rate ${errorRate}`,
  };
  writeEvidence(args, evidence.gate, evidence);
  return evidence;
}

async function scrapeResidentMemoryBytes(args) {
  if (args.rssCommand) {
    const output = execSync(args.rssCommand, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: "/bin/bash",
    }).trim();
    const parsed = Number(output.split(/\s+/)[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const url = args.metricsUrl || `${args.baseUrl}/metrics`;
  const result = await fetchText(url, {
    headers: { Authorization: `Bearer ${args.apiKey}` },
  });
  if (!result.ok) return null;
  const patterns = [
    /^process_resident_memory_bytes\s+(\d+(?:\.\d+)?)$/m,
    /^llamacpp_process_resident_memory_bytes\s+(\d+(?:\.\d+)?)$/m,
  ];
  for (const pattern of patterns) {
    const match = result.text.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

async function runSoak(args) {
  const startRss = await scrapeResidentMemoryBytes(args);
  const startedAt = performance.now();
  const results = [];
  while (performance.now() - startedAt < args.soakMs) {
    const index = results.length;
    const result = await chatCompletion(args, {
      model: args.model,
      messages: [
        {
          role: "user",
          content: `Reply with exactly: soak-${index}`,
        },
      ],
      temperature: 0,
      max_tokens: 12,
      stream: false,
    });
    const contentOk = result.content.toLowerCase().includes(`soak-${index}`);
    results.push({
      ok: result.ok && contentOk,
      status: result.status,
      latencyMs: result.latencyMs,
    });
    const elapsed = performance.now() - startedAt;
    if (elapsed + args.soakIntervalMs > args.soakMs) break;
    await new Promise((resolve) => setTimeout(resolve, args.soakIntervalMs));
  }
  const endRss = await scrapeResidentMemoryBytes(args);
  const durationMs = Math.round(performance.now() - startedAt);
  const errors = results.filter((result) => !result.ok).length;
  const crashFree = errors === 0;
  const rssDeltaBytes =
    startRss !== null && endRss !== null
      ? Math.max(0, endRss - startRss)
      : null;
  const rssLeakWithinBudget =
    rssDeltaBytes !== null && rssDeltaBytes <= 256 * 1024 * 1024;
  const evidence = {
    gate: "one_hour_soak",
    status:
      durationMs >= 3_540_000 && crashFree && rssLeakWithinBudget
        ? "pass"
        : "fail",
    completedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    model: args.model,
    durationMs,
    requests: results.length,
    crashFree,
    rssLeakWithinBudget,
    startRssBytes: startRss,
    endRssBytes: endRss,
    rssDeltaBytes,
    p95Ms: percentile(
      results.map((result) => result.latencyMs),
      0.95,
    ),
    summary: `soak ${Math.round(durationMs / 1000)}s; requests ${results.length}; crash-free ${crashFree}; rss budget ${rssLeakWithinBudget}`,
  };
  writeEvidence(args, evidence.gate, evidence);
  return evidence;
}

async function runFailover(args) {
  if (!args.failoverFallbackUrl || !args.failoverKillCommand) {
    throw new Error(
      "failover requires --failover-fallback-url and --failover-kill-command",
    );
  }
  const baseline = await chatCompletion(args, {
    model: args.model,
    messages: [
      { role: "user", content: "Reply with exactly: failover-before" },
    ],
    temperature: 0,
    max_tokens: 12,
    stream: false,
  });
  execSync(args.failoverKillCommand, { stdio: "ignore", shell: "/bin/bash" });
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const primaryAfter = await chatCompletion(args, {
    model: args.model,
    messages: [
      { role: "user", content: "Reply with exactly: failover-primary" },
    ],
    temperature: 0,
    max_tokens: 12,
    stream: false,
  });
  const fallbackAfter = await chatCompletion(
    args,
    {
      model: args.model,
      messages: [
        { role: "user", content: "Reply with exactly: failover-fallback" },
      ],
      temperature: 0,
      max_tokens: 12,
      stream: false,
    },
    args.failoverFallbackUrl.replace(/\/+$/, ""),
  );

  const readinessFlipped = baseline.ok && !primaryAfter.ok;
  const trafficMoved =
    fallbackAfter.ok &&
    fallbackAfter.content.toLowerCase().includes("failover-fallback");
  const evidence = {
    gate: "failover_kill",
    status: readinessFlipped && trafficMoved ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    killedNode: args.failoverKilledNode || args.instanceId,
    readinessFlipped,
    trafficMoved,
    primaryBeforeStatus: baseline.status,
    primaryAfterStatus: primaryAfter.status,
    fallbackAfterStatus: fallbackAfter.status,
    summary: `killed ${args.failoverKilledNode || args.instanceId}; readiness flipped ${readinessFlipped}; traffic moved ${trafficMoved}`,
  };
  writeEvidence(args, evidence.gate, evidence);
  return evidence;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.runLive) await runLive(args);
  if (args.runSmoke) await runSmoke(args);
  if (args.runParity) await runParity(args);
  if (args.runBurst) await runBurst(args);
  if (args.runSoak) await runSoak(args);
  if (args.runFailover) await runFailover(args);
}

main().catch((error) => {
  console.error(`[eliza1:harness] ${error.message}`);
  process.exit(1);
});
