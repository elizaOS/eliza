#!/usr/bin/env node
/**
 * Privacy-safe live latency probe for Cerebras direct, the Eliza Cloud model
 * gateway, and dedicated agents.
 *
 * The probe never prints credentials, prompts, or generated text. Each JSONL
 * record contains only timing boundaries, selected response headers, token
 * usage, output length, and whether a random proof nonce was returned.
 */

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TARGETS = new Set(["direct", "gateway", "paired", "dedicated"]);
const REASONING_EFFORTS = new Set(["omit", "none", "low", "medium", "high"]);
const SAFE_RESPONSE_HEADERS = [
  "cf-placement",
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
  "zai-glm-4.7@none@4096",
  // Separate correctness case: explicit `none` must preserve a small cap.
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

function boundedNumber(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
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

export function parsePreforwardHeader(value) {
  if (!value) return {};
  const result = {};
  for (const field of value.split(";")) {
    const [rawName, rawDuration] = field.split("=", 2);
    const name = rawName?.trim();
    const duration = Number(rawDuration);
    if (
      name &&
      /^[A-Za-z0-9_-]+$/.test(name) &&
      Number.isFinite(duration) &&
      duration >= 0
    ) {
      result[name] = round(duration);
    }
  }
  return result;
}

export function buildProofPrompt(promptOverride, proof) {
  const instruction = `Include this exact token in the answer: ${proof}`;
  const custom = promptOverride?.trim();
  return custom
    ? `${custom}\n\n${instruction}`
    : `Reply briefly. ${instruction}`;
}

function seededRandom(seed) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
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

function dedicatedErrorCode(error) {
  const message = error?.message;
  return typeof message === "string" &&
    /^(?:CreateConversationHttp\d{3}|ConversationIdMissing)$/.test(message)
    ? message
    : null;
}

export async function safeHttpError(response) {
  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    // error-policy:J3 untrusted provider bodies remain an explicit HTTP
    // failure, but arbitrary text never enters the evidence artifact.
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
  let sawDone = false;
  let malformedEvents = 0;

  const consumeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawDone = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      malformedEvents += 1;
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
    sawDone,
    malformedEvents,
  };
}

function finiteFields(source, allowed) {
  if (!source || typeof source !== "object") return null;
  const result = Object.fromEntries(
    allowed
      .map((key) => [key, source[key]])
      .filter(([, value]) => Number.isFinite(value) && value >= 0),
  );
  return Object.keys(result).length > 0 ? result : null;
}

function finiteRecord(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const result = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        /^[A-Za-z0-9_.:-]{1,100}$/.test(key) &&
        Number.isFinite(value) &&
        value >= 0,
    ),
  );
  return Object.keys(result).length > 0 ? result : null;
}

export function safeTerminalTelemetry(value) {
  if (!value || typeof value !== "object") return null;
  const agentRoute = finiteFields(value.agentRoute, [
    "ingressToSseOpenMs",
    "ingressToFirstStatusMs",
    "ingressToFirstTokenMs",
    "ingressToDoneMs",
    "ingressToErrorMs",
  ]);
  const runtimeSource =
    value.runtime && typeof value.runtime === "object" ? value.runtime : null;
  const runtimeScalars = finiteFields(runtimeSource, [
    "totalMs",
    "replyReadyMs",
    "modelFirstSafeChunkMs",
  ]);
  const provider = safeErrorToken(runtimeSource?.provider);
  const contributions = finiteRecord(runtimeSource?.contributions);
  const marks = finiteRecord(runtimeSource?.marks);
  const runtime = {
    ...(runtimeScalars || {}),
    ...(provider ? { provider } : {}),
    ...(contributions ? { contributions } : {}),
    ...(marks ? { marks } : {}),
  };
  const result = {
    ...(agentRoute ? { agentRoute } : {}),
    ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
  };
  return Object.keys(result).length > 0 ? result : null;
}

function ciContext() {
  const env = (name) => process.env[name] || null;
  return {
    sha: env("GITHUB_SHA"),
    gatewayDeploySha: env("ELIZA_GATEWAY_DEPLOY_SHA"),
    runId: env("GITHUB_RUN_ID"),
    runAttempt: env("GITHUB_RUN_ATTEMPT"),
    runnerOs: env("RUNNER_OS"),
    runnerArch: env("RUNNER_ARCH"),
  };
}

function baseRecord(target, sequence, metadata = {}) {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    target,
    sequence,
    ci: ciContext(),
    ...metadata,
  };
}

export async function probeOpenAi({
  target,
  probeCase,
  baseUrl,
  apiKey,
  promptOverride,
  proof,
  timeoutMs,
  sequence,
  metadata,
  fetchImpl = fetch,
}) {
  const expectedProof = proof || ["latency-proof", randomUUID()].join("-");
  const prompt = buildProofPrompt(promptOverride, expectedProof);
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
      ...baseRecord(target, sequence, metadata),
      ok: false,
      transportOk: false,
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
      ...baseRecord(target, sequence, metadata),
      ok: false,
      transportOk: false,
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
  const proofMatched = stream.outputText.includes(expectedProof);
  const cleanCompletion =
    stream.sawDone &&
    stream.malformedEvents === 0 &&
    stream.finishReason !== null &&
    !stream.providerError;
  return {
    ...baseRecord(target, sequence, metadata),
    ok: cleanCompletion && proofMatched,
    transportOk: cleanCompletion,
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
    sawDone: stream.sawDone,
    malformedEvents: stream.malformedEvents,
    cleanCompletion,
    usage: stream.usage,
    providerError: stream.providerError,
    headers,
    serverTiming,
    preforward: parsePreforwardHeader(
      response.headers.get("x-eliza-preforward-ms"),
    ),
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

export async function probeDedicated({
  agentId,
  baseUrl,
  apiKey,
  promptOverride,
  proof,
  timeoutMs,
  sequence,
  metadata,
  keepConversation,
  fetchImpl = fetch,
}) {
  const target = "dedicated";
  const traceId = `latency_${randomUUID()}`;
  const expectedProof = proof || ["latency-proof", randomUUID()].join("-");
  const prompt = buildProofPrompt(promptOverride, expectedProof);
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
        ...baseRecord(target, sequence, metadata),
        ok: false,
        transportOk: false,
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
    const proofMatched = stream.outputText.includes(expectedProof);
    const terminalType = stream.terminal?.type ?? null;
    const cleanCompletion =
      terminalType === "done" && stream.malformedEvents === 0;
    return {
      ...baseRecord(target, sequence, metadata),
      ok: cleanCompletion && proofMatched,
      transportOk: cleanCompletion,
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
      terminalType,
      malformedEvents: stream.malformedEvents,
      cleanCompletion,
      outputCharacters: stream.outputCharacters,
      headers,
      serverTiming,
      preforward: parsePreforwardHeader(
        response.headers.get("x-eliza-preforward-ms"),
      ),
      terminalTelemetry: safeTerminalTelemetry(stream.terminal?.telemetry),
    };
  } catch (error) {
    return {
      ...baseRecord(target, sequence, metadata),
      ok: false,
      transportOk: false,
      agentId,
      traceId,
      networkError: safeErrorToken(error?.name) || "DedicatedProbeError",
      errorCode: dedicatedErrorCode(error),
    };
  } finally {
    if (conversationId && !keepConversation) {
      let cleanupFailure = null;
      try {
        const cleanupResponse = await fetchImpl(
          `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!cleanupResponse.ok) {
          cleanupFailure = `DeleteConversationHttp${cleanupResponse.status}`;
        }
      } catch (error) {
        // error-policy:J6 teardown is best-effort, but retained benchmark state
        // must be visible without printing arbitrary network error messages.
        cleanupFailure =
          safeErrorToken(error?.name) || "ConversationCleanupError";
      }
      if (cleanupFailure) {
        process.stderr.write(
          `[chat-latency] conversation cleanup failed: ${cleanupFailure}\n`,
        );
      }
    }
  }
}

export async function runPairedProbes({
  cases,
  repeats,
  direct,
  gateway,
  promptOverride,
  timeoutMs,
  idleMs,
  pairIntervalMs = 0,
  seed,
  fetchImpl = fetch,
  sleepImpl = (durationMs) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs)),
  onRecord = () => undefined,
}) {
  const random = seededRandom(seed);
  const records = [];
  const targets = { direct, gateway };
  const nextFirstTarget = new Map();

  const runPhase = async (
    phase,
    count,
    { idleBeforeEachTarget = false, pacePairs = false } = {},
  ) => {
    for (let sequence = 1; sequence <= count; sequence += 1) {
      for (const probeCase of shuffled(cases, random)) {
        if (pacePairs && pairIntervalMs > 0) {
          await sleepImpl(pairIntervalMs);
        }
        const proof = `latency-proof-${randomUUID()}`;
        const pairId = randomUUID();
        const caseKey = JSON.stringify([
          probeCase.model,
          probeCase.reasoningEffort,
          probeCase.maxTokens,
        ]);
        const first =
          nextFirstTarget.get(caseKey) ??
          (random() < 0.5 ? `direct` : `gateway`);
        const second = first === `direct` ? `gateway` : `direct`;
        const order = [first, second];
        nextFirstTarget.set(caseKey, second);
        for (const target of order) {
          if (idleBeforeEachTarget && idleMs > 0) {
            await sleepImpl(idleMs);
          }
          const config = targets[target];
          const record = await probeOpenAi({
            target,
            probeCase,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            promptOverride,
            proof,
            timeoutMs,
            sequence,
            metadata: {
              phase,
              pairId,
              targetOrder: order.join(">"),
              benchmarkSeed: seed,
              idleBeforeTargetMs: idleBeforeEachTarget ? idleMs : 0,
              pairIntervalMs: pacePairs ? pairIntervalMs : 0,
            },
            fetchImpl,
          });
          records.push(record);
          onRecord(record);
        }
      }
    }
  };

  await runPhase("cold", 1);
  await runPhase("warm", repeats, { pacePairs: true });
  await runPhase("post-idle", 1, { idleBeforeEachTarget: true });
  return records;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(sorted[lower]);
  const weight = index - lower;
  return round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export function summarizeLatencyRecords(records) {
  const groups = new Map();
  for (const record of records) {
    if (record.phase !== "warm") continue;
    const key = JSON.stringify([
      record.target,
      record.model,
      record.reasoningEffort,
      record.maxTokens,
    ]);
    const group = groups.get(key) || {
      target: record.target,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      maxTokens: record.maxTokens,
      records: [],
    };
    group.records.push(record);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const successful = group.records.filter((record) => record.ok);
      const metric = (selector) => {
        const values = successful
          .map(selector)
          .filter((value) => Number.isFinite(value));
        return {
          p50: percentile(values, 0.5),
          p90: percentile(values, 0.9),
          p95: percentile(values, 0.95),
        };
      };
      return {
        target: group.target,
        model: group.model,
        reasoningEffort: group.reasoningEffort,
        maxTokens: group.maxTokens,
        samples: group.records.length,
        successes: successful.length,
        failures: group.records.length - successful.length,
        responseHeadersMs: metric((record) => record.responseHeadersMs),
        firstTokenMs: metric((record) => record.firstTokenMs),
        totalMs: metric((record) => record.totalMs),
        preforwardMs: metric((record) => record.preforward?.total),
      };
    })
    .sort((left, right) =>
      [left.model, left.reasoningEffort, left.maxTokens, left.target]
        .join(":")
        .localeCompare(
          [
            right.model,
            right.reasoningEffort,
            right.maxTokens,
            right.target,
          ].join(":"),
        ),
    );
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: chat-latency.mjs --target direct|gateway|paired|dedicated [options]",
      "",
      "OpenAI-compatible targets:",
      "  --case model[@omit|none|low|medium|high][@max_tokens] (repeatable)",
      "  --model model (repeatable; uses --reasoning-effort and --max-tokens)",
      "  --target paired counterbalances identical direct/gateway requests",
      "",
      "Dedicated target:",
      "  --agent-id uuid [--base-url https://agent-host]",
      "",
      "Common:",
      "  --repeat 1..100 --timeout-ms 1000..180000 --api-key-env NAME",
      "  --idle-ms 0..300000 --pair-interval-ms 0..60000",
      "  --seed SAFE_ID --prompt text",
      "  --max-proof-miss-rate 0..1 (paired benchmark only)",
      "  --keep-conversation",
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
      "direct-api-key-env": { type: "string" },
      "gateway-api-key-env": { type: "string" },
      "direct-base-url": { type: "string" },
      "gateway-base-url": { type: "string" },
      "idle-ms": { type: "string", default: "30000" },
      "pair-interval-ms": { type: "string", default: "0" },
      seed: { type: "string" },
      "max-proof-miss-rate": { type: "string", default: "0" },
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
  const repeats = boundedInteger(values.repeat, "repeat", 1, 100);
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
  const idleMs = boundedInteger(values["idle-ms"], "idle-ms", 0, 300_000);
  const pairIntervalMs = boundedInteger(
    values["pair-interval-ms"],
    "pair-interval-ms",
    0,
    60_000,
  );
  const maxProofMissRate = boundedNumber(
    values["max-proof-miss-rate"],
    "max-proof-miss-rate",
    0,
    1,
  );
  const benchmarkSeed =
    values.seed?.trim() || ["latency", randomUUID()].join("-");
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(benchmarkSeed)) {
    throw new Error("--seed must be a privacy-safe identifier");
  }

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

  const readKey = (name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("Credential environment variable name is invalid");
    }
    const key = process.env[name]?.trim();
    if (!key) {
      throw new Error(`Set ${name}; credential values are never printed`);
    }
    return key;
  };

  let records = [];
  let streamedRecords = false;
  if (target === "paired") {
    const directKeyEnv = values["direct-api-key-env"] || "CEREBRAS_API_KEY";
    const gatewayKeyEnv =
      values["gateway-api-key-env"] || "ELIZA_CLOUD_API_KEY";
    records = await runPairedProbes({
      cases,
      repeats,
      direct: {
        baseUrl: values["direct-base-url"] || "https://api.cerebras.ai",
        apiKey: readKey(directKeyEnv),
      },
      gateway: {
        baseUrl: values["gateway-base-url"] || "https://api.elizacloud.ai",
        apiKey: readKey(gatewayKeyEnv),
      },
      promptOverride: values.prompt,
      timeoutMs,
      idleMs,
      pairIntervalMs,
      seed: benchmarkSeed,
      onRecord: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
    });
    streamedRecords = true;
  } else {
    const defaultKeyEnv =
      target === "direct" ? "CEREBRAS_API_KEY" : "ELIZA_CLOUD_API_KEY";
    const keyEnv = values["api-key-env"] || defaultKeyEnv;
    const apiKey = readKey(keyEnv);
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
  }

  if (!streamedRecords) {
    for (const record of records) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  }
  if (streamedRecords) {
    const transportPassed = records.every(
      (record) => record.transportOk === true,
    );
    const completed = records.filter((record) => record.transportOk === true);
    const proofMisses = completed.filter(
      (record) => record.proofMatched !== true,
    ).length;
    const proofMissRate = completed.length ? proofMisses / completed.length : 1;
    return transportPassed && proofMissRate <= maxProofMissRate ? 0 : 2;
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
