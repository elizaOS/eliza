#!/usr/bin/env node
/**
 * Privacy-safe live latency probe for Cerebras direct, the Eliza Cloud model
 * gateway, and dedicated agents.
 *
 * The probe never prints credentials, prompts, or generated text. Each JSONL
 * record contains only timing boundaries, selected response headers, token
 * usage, output length, and whether a random proof nonce was returned.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TARGETS = new Set(["direct", "gateway", "dedicated"]);
const REASONING_EFFORTS = new Set(["omit", "none", "low", "medium", "high"]);
const SAFE_RESPONSE_HEADERS = [
  "cf-ray",
  "server-timing",
  "x-eliza-trace-id",
  "x-eliza-preforward-ms",
  "x-eliza-inference-path",
  "x-request-id",
];

export const DEFAULT_PROBE_CASES = [
  "gemma-4-31b@omit@512",
  "gemma-4-31b@none@512",
  "zai-glm-4.7@omit@4096",
  "zai-glm-4.7@none@512",
];

function boundedInteger(value, label, minimum, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

export function parseProbeCase(raw, fallbackMaxTokens = 512) {
  const parts = String(raw).split("@");
  if (parts.length > 3) {
    throw new Error(
      `Probe case must be model[@reasoning_effort][@max_tokens]: ${raw}`,
    );
  }
  const model = parts[0]?.trim();
  const reasoningEffort = (parts[1]?.trim() || "omit").toLowerCase();
  if (!model) throw new Error("Probe case model must not be empty");
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort in probe case: ${raw}`);
  }
  const maxTokens = boundedInteger(
    parts[2]?.trim() || fallbackMaxTokens,
    "max_tokens",
    1,
    16_384,
  );
  return { model, reasoningEffort, maxTokens };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function elapsed(now, startedAt) {
  return round(now() - startedAt);
}

export function parseServerTiming(value) {
  if (!value) return {};
  const result = {};
  for (const entry of value.split(",")) {
    const [rawName, ...parameters] = entry.trim().split(";");
    const name = rawName?.trim();
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const duration = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("dur="));
    if (!duration) continue;
    const number = Number(duration.slice(4).replace(/^"|"$/g, ""));
    if (Number.isFinite(number) && number >= 0) result[name] = round(number);
  }
  return result;
}

export function selectedResponseHeaders(headers) {
  return Object.fromEntries(
    SAFE_RESPONSE_HEADERS.map((name) => [name, headers.get(name)]).filter(
      ([, value]) => typeof value === "string" && value.length > 0,
    ),
  );
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const allowed = [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
  ];
  const usage = Object.fromEntries(
    allowed
      .map((key) => [key, value[key]])
      .filter(([, number]) => Number.isFinite(number) && number >= 0),
  );
  return Object.keys(usage).length > 0 ? usage : null;
}

function safeErrorToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value)
    ? value
    : null;
}

export async function safeHttpError(response) {
  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    // Deliberately omit arbitrary upstream response text from evidence.
  }
  const source =
    parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
  return {
    status: response.status,
    type: safeErrorToken(source?.type),
    code: safeErrorToken(source?.code),
  };
}

export function buildOpenAiRequestBody(probeCase, prompt) {
  const body = {
    model: probeCase.model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: probeCase.maxTokens,
  };
  if (probeCase.reasoningEffort !== "omit") {
    body.reasoning_effort = probeCase.reasoningEffort;
  }
  return body;
}

export function consumeOpenAiEvent(event) {
  const choice = event?.choices?.[0];
  const delta = choice?.delta;
  const content = typeof delta?.content === "string" ? delta.content : "";
  const reasoningCandidates = [
    delta?.reasoning_content,
    delta?.reasoning,
    delta?.thinking,
  ];
  const reasoning =
    reasoningCandidates.find((value) => typeof value === "string") || "";
  const error = event?.error;
  return {
    content,
    reasoning,
    finishReason:
      typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: normalizeUsage(event?.usage),
    providerError:
      error && typeof error === "object"
        ? {
            type: safeErrorToken(error.type),
            code: safeErrorToken(error.code),
          }
        : null,
  };
}

export function consumeAgentEvent(event) {
  const candidates =
    event?.type === "token"
      ? [event.text, event.delta, event.token]
      : [event?.delta, event?.token];
  const content = candidates.find((value) => typeof value === "string") || "";
  return {
    content,
    terminal: event?.type === "done" || event?.type === "error" ? event : null,
  };
}

export async function readSse(
  body,
  startedAt,
  consumeEvent,
  now = () => performance.now(),
) {
  if (!body) throw new Error("Response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstEventMs = null;
  let firstReasoningMs = null;
  let firstTokenMs = null;
  let outputCharacters = 0;
  let reasoningCharacters = 0;
  let outputText = "";
  let usage = null;
  let finishReason = null;
  let providerError = null;
  let terminal = null;

  const consumeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (firstEventMs === null) firstEventMs = elapsed(now, startedAt);
    const observation = consumeEvent(event) || {};
    if (observation.reasoning) {
      if (firstReasoningMs === null) {
        firstReasoningMs = elapsed(now, startedAt);
      }
      reasoningCharacters += observation.reasoning.length;
    }
    if (observation.content) {
      if (firstTokenMs === null) firstTokenMs = elapsed(now, startedAt);
      outputText += observation.content;
      outputCharacters += observation.content.length;
    }
    if (observation.usage) usage = observation.usage;
    if (observation.finishReason) finishReason = observation.finishReason;
    if (observation.providerError) providerError = observation.providerError;
    if (observation.terminal) terminal = observation.terminal;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer.trim());

  return {
    firstEventMs,
    firstReasoningMs,
    firstTokenMs,
    outputCharacters,
    reasoningCharacters,
    outputText,
    usage,
    finishReason,
    providerError,
    terminal,
  };
}

function safeTerminalTelemetry(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return null;
  const allowedKey =
    /(?:trace|timing|latency|duration|elapsed|ttf|first|done|status|stage|hop|path|provider|model|request)/i;
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    if (!allowedKey.test(key)) continue;
    if (
      typeof child === "number" ||
      typeof child === "boolean" ||
      (typeof child === "string" && child.length <= 160)
    ) {
      entries.push([key, child]);
      continue;
    }
    const nested = safeTerminalTelemetry(child, depth + 1);
    if (nested && Object.keys(nested).length > 0) entries.push([key, nested]);
  }
  return Object.fromEntries(entries);
}

function ciContext() {
  const env = (name) => process.env[name] || null;
  return {
    sha: env("GITHUB_SHA"),
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    runnerOs: env("RUNNER_OS"),
    runnerArch: env("RUNNER_ARCH"),
  };
}

function baseRecord(target, sequence) {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    target,
    sequence,
    ci: ciContext(),
  };
}

async function probeOpenAi({
  target,
  probeCase,
  baseUrl,
  apiKey,
  promptOverride,
  timeoutMs,
  sequence,
  fetchImpl = fetch,
}) {
  const proof = `latency-proof-${randomUUID()}`;
  const prompt =
    promptOverride || `Reply with one short sentence containing ${proof}`;
  const traceId = `latency_${randomUUID()}`;
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root + (target === "direct" ? "/v1" : "/api/v1")}/chat/completions`;
  const startedAt = performance.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Eliza-Trace-Id": traceId,
        "X-Eliza-Telemetry": "full",
        "User-Agent": "eliza-chat-latency/1.0",
      },
      body: JSON.stringify(buildOpenAiRequestBody(probeCase, prompt)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ...baseRecord(target, sequence),
      ok: false,
      model: probeCase.model,
      reasoningEffort: probeCase.reasoningEffort,
      maxTokens: probeCase.maxTokens,
      traceId,
      totalMs: round(performance.now() - startedAt),
      networkError: safeErrorToken(error?.name) || "NetworkError",
    };
  }

  const responseHeadersMs = round(performance.now() - startedAt);
  const headers = selectedResponseHeaders(response.headers);
  const serverTiming = parseServerTiming(response.headers.get("server-timing"));
  if (!response.ok) {
    return {
      ...baseRecord(target, sequence),
      ok: false,
      model: probeCase.model,
      reasoningEffort: probeCase.reasoningEffort,
      maxTokens: probeCase.maxTokens,
      traceId: response.headers.get("x-eliza-trace-id") || traceId,
      responseHeadersMs,
      totalMs: round(performance.now() - startedAt),
      headers,
      serverTiming,
      error: await safeHttpError(response),
    };
  }

  const stream = await readSse(response.body, startedAt, consumeOpenAiEvent);
  const totalMs = round(performance.now() - startedAt);
  const proofMatched = stream.outputText.includes(proof);
  return {
    ...baseRecord(target, sequence),
    ok: !stream.providerError && proofMatched,
    model: probeCase.model,
    reasoningEffort: probeCase.reasoningEffort,
    maxTokens: probeCase.maxTokens,
    status: response.status,
    traceId: response.headers.get("x-eliza-trace-id") || traceId,
    responseHeadersMs,
    firstEventMs: stream.firstEventMs,
    firstReasoningMs: stream.firstReasoningMs,
    firstTokenMs: stream.firstTokenMs,
    totalMs,
    headersToFirstEventMs:
      stream.firstEventMs === null
        ? null
        : round(stream.firstEventMs - responseHeadersMs),
    headersToFirstTokenMs:
      stream.firstTokenMs === null
        ? null
        : round(stream.firstTokenMs - responseHeadersMs),
    firstTokenToDoneMs:
      stream.firstTokenMs === null
        ? null
        : round(totalMs - stream.firstTokenMs),
    proofMatched,
    outputCharacters: stream.outputCharacters,
    reasoningCharacters: stream.reasoningCharacters,
    finishReason: stream.finishReason,
    usage: stream.usage,
    providerError: stream.providerError,
    headers,
    serverTiming,
  };
}

async function createConversation(baseUrl, apiKey, traceId, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Eliza-Trace-Id": traceId,
      "User-Agent": "eliza-chat-latency/1.0",
    },
    body: JSON.stringify({ title: `latency-${Date.now()}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`CreateConversationHttp${response.status}`);
  }
  const body = await response.json();
  const id = body?.conversation?.id || body?.id;
  if (typeof id !== "string") throw new Error("ConversationIdMissing");
  return id;
}

async function probeDedicated({
  agentId,
  baseUrl,
  apiKey,
  promptOverride,
  timeoutMs,
  sequence,
  keepConversation,
  fetchImpl = fetch,
}) {
  const target = "dedicated";
  const traceId = `latency_${randomUUID()}`;
  const proof = `latency-proof-${randomUUID()}`;
  const prompt =
    promptOverride || `Reply with one short sentence containing ${proof}`;
  let conversationId = null;
  try {
    conversationId = await createConversation(
      baseUrl,
      apiKey,
      traceId,
      fetchImpl,
    );
    const startedAt = performance.now();
    const response = await fetchImpl(
      baseUrl +
        "/api/conversations/" +
        encodeURIComponent(conversationId) +
        "/messages/stream",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "X-Eliza-Trace-Id": traceId,
          "X-Eliza-Telemetry": "full",
          "User-Agent": "eliza-chat-latency/1.0",
        },
        body: JSON.stringify({
          text: prompt,
          channelType: "DM",
          clientMessageId: randomUUID(),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const responseHeadersMs = round(performance.now() - startedAt);
    const headers = selectedResponseHeaders(response.headers);
    const serverTiming = parseServerTiming(
      response.headers.get("server-timing"),
    );
    if (!response.ok) {
      return {
        ...baseRecord(target, sequence),
        ok: false,
        agentId,
        traceId: response.headers.get("x-eliza-trace-id") || traceId,
        responseHeadersMs,
        totalMs: round(performance.now() - startedAt),
        headers,
        serverTiming,
        error: await safeHttpError(response),
      };
    }
    const stream = await readSse(response.body, startedAt, consumeAgentEvent);
    const totalMs = round(performance.now() - startedAt);
    const proofMatched = stream.outputText.includes(proof);
    return {
      ...baseRecord(target, sequence),
      ok: proofMatched,
      agentId,
      status: response.status,
      traceId: response.headers.get("x-eliza-trace-id") || traceId,
      responseHeadersMs,
      firstEventMs: stream.firstEventMs,
      firstTokenMs: stream.firstTokenMs,
      totalMs,
      headersToFirstTokenMs:
        stream.firstTokenMs === null
          ? null
          : round(stream.firstTokenMs - responseHeadersMs),
      firstTokenToDoneMs:
        stream.firstTokenMs === null
          ? null
          : round(totalMs - stream.firstTokenMs),
      proofMatched,
      outputCharacters: stream.outputCharacters,
      headers,
      serverTiming,
      terminalTelemetry: safeTerminalTelemetry(stream.terminal?.telemetry),
    };
  } catch (error) {
    return {
      ...baseRecord(target, sequence),
      ok: false,
      agentId,
      traceId,
      networkError: safeErrorToken(error?.name) || "DedicatedProbeError",
      errorCode: safeErrorToken(error?.message),
    };
  } finally {
    if (conversationId && !keepConversation) {
      await fetchImpl(
        `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      ).catch(() => undefined);
    }
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: chat-latency.mjs --target direct|gateway|dedicated [options]",
      "",
      "OpenAI-compatible targets:",
      "  --case model[@omit|none|low|medium|high][@max_tokens] (repeatable)",
      "  --model model (repeatable; uses --reasoning-effort and --max-tokens)",
      "",
      "Dedicated target:",
      "  --agent-id uuid [--base-url https://agent-host]",
      "",
      "Common:",
      "  --repeat 1..10 --timeout-ms 1000..180000 --api-key-env NAME",
      "  --prompt text --keep-conversation",
      "",
      "Credentials are read only from environment variables and are never printed.",
      "",
    ].join("\n"),
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string", default: "gateway" },
      case: { type: "string", multiple: true },
      model: { type: "string", multiple: true },
      "reasoning-effort": { type: "string", default: "omit" },
      "agent-id": { type: "string" },
      "base-url": { type: "string" },
      prompt: { type: "string" },
      "max-tokens": { type: "string", default: "512" },
      repeat: { type: "string", default: "1" },
      "timeout-ms": { type: "string", default: "90000" },
      "api-key-env": { type: "string" },
      "keep-conversation": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return 0;
  }
  const target = values.target;
  if (!TARGETS.has(target)) throw new Error(`Unsupported target: ${target}`);
  const repeats = boundedInteger(values.repeat, "repeat", 1, 10);
  const timeoutMs = boundedInteger(
    values["timeout-ms"],
    "timeout-ms",
    1_000,
    180_000,
  );
  const fallbackMaxTokens = boundedInteger(
    values["max-tokens"],
    "max-tokens",
    1,
    16_384,
  );
  const defaultKeyEnv =
    target === "direct" ? "CEREBRAS_API_KEY" : "ELIZA_CLOUD_API_KEY";
  const keyEnv = values["api-key-env"] || defaultKeyEnv;
  const apiKey = process.env[keyEnv]?.trim();
  if (!apiKey) {
    throw new Error(`Set ${keyEnv}; credential values are never printed`);
  }

  const records = [];
  if (target === "dedicated") {
    const agentId = values["agent-id"]?.trim();
    if (!agentId)
      throw new Error("--agent-id is required for dedicated probes");
    const baseUrl = (
      values["base-url"] || `https://${agentId}.elizacloud.ai`
    ).replace(/\/+$/, "");
    for (let sequence = 1; sequence <= repeats; sequence += 1) {
      records.push(
        await probeDedicated({
          agentId,
          baseUrl,
          apiKey,
          promptOverride: values.prompt,
          timeoutMs,
          sequence,
          keepConversation: values["keep-conversation"],
        }),
      );
    }
  } else {
    let cases;
    if (values.case?.length) {
      cases = values.case.map((value) =>
        parseProbeCase(value, fallbackMaxTokens),
      );
    } else if (values.model?.length) {
      const effort = values["reasoning-effort"];
      if (!REASONING_EFFORTS.has(effort)) {
        throw new Error(`Unsupported --reasoning-effort: ${effort}`);
      }
      cases = values.model.map((model) =>
        parseProbeCase(
          `${model}@${effort}@${fallbackMaxTokens}`,
          fallbackMaxTokens,
        ),
      );
    } else {
      cases = DEFAULT_PROBE_CASES.map((value) =>
        parseProbeCase(value, fallbackMaxTokens),
      );
    }
    const baseUrl =
      values["base-url"] ||
      (target === "direct"
        ? "https://api.cerebras.ai"
        : "https://api.elizacloud.ai");
    for (const probeCase of cases) {
      for (let sequence = 1; sequence <= repeats; sequence += 1) {
        records.push(
          await probeOpenAi({
            target,
            probeCase,
            baseUrl,
            apiKey,
            promptOverride: values.prompt,
            timeoutMs,
            sequence,
          }),
        );
      }
    }
  }

  for (const record of records) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  return records.every((record) => record.ok) ? 0 : 2;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        "[chat-latency] " +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
      process.exitCode = 1;
    });
}
