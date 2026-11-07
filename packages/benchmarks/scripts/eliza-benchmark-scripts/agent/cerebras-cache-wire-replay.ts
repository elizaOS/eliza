#!/usr/bin/env bun
/**
 * Replays complete captured Cerebras requests with only the optional cache hint changed.
 * This controlled provider experiment is separate from runtime and gateway evidence.
 * Complete SSE responses are retained; credentials and authorization headers are not.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  fingerprintWireRequest,
  type WireRequestShape,
} from "./cerebras-chat-flow-experiment.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected evidence object");
  return value as Record<string, unknown>;
}

export function replayRequest(
  request: Record<string, unknown>,
  mode: "automatic" | "shared-prefix" | "conversation",
  runId: string,
  conversation: string,
): Record<string, unknown> {
  const { prompt_cache_key: originalKey, ...completeRequest } = request;
  if (mode === "automatic") return completeRequest;
  if (mode === "shared-prefix")
    return {
      ...completeRequest,
      prompt_cache_key: `replay:shared:v1:${createHash("sha256")
        .update(JSON.stringify([runId, originalKey]))
        .digest("hex")}`,
    };
  return {
    ...completeRequest,
    prompt_cache_key: `replay:v1:${createHash("sha256")
      .update(JSON.stringify([runId, conversation, originalKey]))
      .digest("hex")}`,
  };
}

/** Reject HTTP-success streams that did not finish or carry provider usage. */
export function validateReplayStream(raw: string): {
  usage: Record<string, unknown>;
  timeInfo: unknown;
} {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.substring(5).trim());
  if (!data.includes("[DONE]"))
    throw new Error("Provider replay stream ended without DONE");
  const events = data
    .filter((line) => line !== "[DONE]")
    .map((line) => object(JSON.parse(line)));
  if (events.some((event) => event.error !== undefined))
    throw new Error("Provider replay returned a stream error");
  const finishReasons = events.flatMap((event) =>
    Array.isArray(event.choices)
      ? event.choices
          .map((choice) => object(choice).finish_reason)
          .filter((reason) => reason != null)
      : [],
  );
  if (
    finishReasons.some(
      (reason) =>
        !["stop", "tool_calls", "function_call"].includes(String(reason)),
    )
  )
    throw new Error(
      `Provider replay did not complete its output: ${finishReasons.join(", ")}`,
    );
  const finished = finishReasons.length > 0;
  const usageEvent = events.findLast((event) => event.usage != null);
  if (!finished || !usageEvent)
    throw new Error("Provider replay lacks completion or usage evidence");
  const usage = object(usageEvent.usage);
  if (
    typeof usage.prompt_tokens !== "number" ||
    usage.prompt_tokens <= 0 ||
    typeof usage.completion_tokens !== "number" ||
    usage.completion_tokens < 0
  )
    throw new Error("Provider replay usage is invalid");
  return {
    usage,
    timeInfo:
      events.findLast((event) => event.time_info != null)?.time_info ?? null,
  };
}

export interface ReplayStreamTelemetry {
  firstTokenMs: number | null;
  firstVisibleTextMs: number | null;
  firstReasoningMs: number | null;
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    freshInputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
  } | null;
  providerTimeInfo: unknown;
  parseErrors: number;
}

/** Streaming observation only; validateReplayStream remains the completion authority. */
export function createReplayStreamTelemetry() {
  const evidence: ReplayStreamTelemetry = {
    firstTokenMs: null,
    firstVisibleTextMs: null,
    firstReasoningMs: null,
    usage: null,
    providerTimeInfo: null,
    parseErrors: 0,
  };
  let pending = "";
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const present = (value: unknown) =>
    typeof value === "string" && value.length > 0;
  const consume = (block: string, elapsedMs: number) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(data));
    } catch {
      evidence.parseErrors++;
      return;
    }
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      const delta = record(record(choice).delta);
      const visible = present(delta.content);
      const reasoning =
        present(delta.reasoning_content) || present(delta.reasoning);
      const tool =
        (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
        Object.keys(record(delta.function_call)).length > 0;
      if (visible && evidence.firstVisibleTextMs === null)
        evidence.firstVisibleTextMs = elapsedMs;
      if (reasoning && evidence.firstReasoningMs === null)
        evidence.firstReasoningMs = elapsedMs;
      if ((visible || reasoning || tool) && evidence.firstTokenMs === null)
        evidence.firstTokenMs = elapsedMs;
    }
    if (event.usage != null) {
      const usage = record(event.usage);
      const inputTokens = count(usage.prompt_tokens ?? usage.input_tokens);
      const cachedInputTokens = count(
        record(usage.prompt_tokens_details ?? usage.input_tokens_details)
          .cached_tokens,
      );
      evidence.usage = {
        inputTokens,
        cachedInputTokens,
        freshInputTokens:
          inputTokens !== null &&
          cachedInputTokens !== null &&
          cachedInputTokens <= inputTokens
            ? inputTokens - cachedInputTokens
            : null,
        outputTokens: count(usage.completion_tokens ?? usage.output_tokens),
        reasoningTokens: count(
          record(usage.completion_tokens_details ?? usage.output_tokens_details)
            .reasoning_tokens,
        ),
      };
    }
    if (event.time_info != null) evidence.providerTimeInfo = event.time_info;
  };
  return {
    evidence,
    push(text: string, elapsedMs: number, finished = false) {
      pending += text;
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() ?? "";
      for (const block of blocks) consume(block, elapsedMs);
      if (finished && pending) {
        consume(pending, elapsedMs);
        pending = "";
      }
    },
  };
}

export interface ReplayAttempt {
  index: number;
  order: number;
  mode: "automatic" | "shared-prefix" | "conversation";
  attempt: number;
  originalContext: Record<string, unknown>;
  request: Record<string, unknown>;
  requestShape?: WireRequestShape;
  streamTelemetry?: ReplayStreamTelemetry;
  outcome?: "dispatching" | "response" | "transport-error";
  status?: number;
  headersMs?: number;
  totalMs?: number;
  rawResponse?: string;
  responseComplete?: boolean;
  rawResponseBytesBase64?: string;
  error?: string;
}

/** Retain the attempted request before dispatch and every received body byte on failure. */
export async function captureReplayAttempt(options: {
  endpoint: string;
  apiKey: string;
  row: ReplayAttempt;
  rows: ReplayAttempt[];
  persist: () => Promise<void>;
}) {
  const { row, rows, persist } = options;
  row.outcome = "dispatching";
  row.responseComplete = false;
  row.rawResponse = "";
  const requestBody = JSON.stringify(row.request);
  row.requestShape = fingerprintWireRequest(
    requestBody,
    rows.length ? JSON.stringify(rows[rows.length - 1]?.request) : undefined,
  );
  const telemetry = createReplayStreamTelemetry();
  row.streamTelemetry = telemetry.evidence;
  rows.push(row);
  await persist();
  const startedAt = performance.now();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let response: Response;
  try {
    response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
    });
    row.headersMs = performance.now() - startedAt;
    row.status = response.status;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          const text = decoder.decode(value, { stream: true });
          row.rawResponse += text;
          telemetry.push(text, performance.now() - startedAt);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const finalText = decoder.decode();
    row.rawResponse += finalText;
    telemetry.push(finalText, performance.now() - startedAt, true);
    row.responseComplete = true;
    row.outcome = "response";
    row.totalMs = performance.now() - startedAt;
  } catch (error) {
    // error-policy:J2 retain this failed transport attempt before the CLI preserves its terminal report.
    row.rawResponse += decoder.decode();
    row.rawResponseBytesBase64 = Buffer.concat(chunks).toString("base64");
    row.outcome = "transport-error";
    row.totalMs = performance.now() - startedAt;
    row.error = error instanceof Error ? error.message : String(error);
    await persist();
    throw error;
  }
  await persist();
  return {
    ok: response.ok,
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    rawResponse: row.rawResponse,
  };
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw new Error(
      "Usage: cerebras-cache-wire-replay.ts <runtime-report.json> <replay-report.json>",
    );
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY is required");
  if (process.env.ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED !== "true")
    throw new Error(
      "Verify optional prompt_cache_key account capability first",
    );
  const { sourceRevisionEvidence } = await import(
    "./cerebras-chat-flow-latency.ts"
  );
  const sourceRevision = sourceRevisionEvidence();
  const inputBytes = await readFile(input);
  const report = object(JSON.parse(inputBytes.toString()));
  if (!Array.isArray(report.wireEvidence))
    throw new Error("Runtime report has no complete wire evidence");
  const selected = report.wireEvidence
    .map(object)
    .filter(
      (wire) =>
        wire.kind === "text" &&
        wire.status === 200 &&
        object(wire.context).phase === "sample" &&
        typeof object(wire.request).prompt_cache_key === "string",
    );
  if (selected.length < 30)
    throw new Error("At least 30 captured sample calls are required");
  const runId = randomUUID();
  const rows: ReplayAttempt[] = [];
  const modes = ["automatic", "shared-prefix", "conversation"] as const;
  const persist = async (
    status: "running" | "failed" | "complete",
    error?: unknown,
  ) => {
    await writeFile(
      output,
      `${JSON.stringify({ experiment: "matched-complete-wire-provider-replay", status, sourceRevision, sourceReportSha256: createHash("sha256").update(inputBytes).digest("hex"), runId, limitations: "Provider replay only. Shared and conversation keys are run-scoped. Automatic-prefix cache may already be warm. Mode order rotates; independent cache isolation and eviction are not guaranteed.", rows, ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  };
  await persist("running");
  try {
    // Thirty complete calls are the explicitly requested experiment sample;
    // no message, prompt, tool definition, output or context is shortened.
    for (let index = 0; index < 30; index++) {
      const wire = selected[index];
      if (!wire) throw new Error("Missing selected request");
      const original = object(wire.request);
      if (
        original.model !== "qwen-3.8-27b" ||
        original.stream !== true ||
        !Array.isArray(original.messages)
      )
        throw new Error("Replay requires complete streaming qwen requests");
      if (
        typeof original.prompt_cache_key !== "string" ||
        original.prompt_cache_key.includes("REDACTED")
      )
        throw new Error(
          "Existing-affinity source must retain the actual non-secret cache key",
        );
      const context = object(wire.context);
      const conversation = String(context.roomId);
      if (!conversation || conversation === "undefined")
        throw new Error("Missing original conversation identity");
      for (let offset = 0; offset < modes.length; offset++) {
        const mode = modes[(index + offset) % modes.length];
        if (!mode) throw new Error("Missing experiment mode");
        const request = replayRequest(original, mode, runId, conversation);
        let attempt = 0;
        while (true) {
          attempt++;
          const response = await captureReplayAttempt({
            endpoint: "https://api.cerebras.ai/v1/chat/completions",
            apiKey,
            row: {
              index,
              order: offset,
              mode,
              attempt,
              originalContext: context,
              request,
            },
            rows,
            persist: () => persist("running"),
          });
          if (response.status === 429 && attempt < 3) {
            const rawRetry = response.retryAfter;
            const seconds = rawRetry === null ? NaN : Number(rawRetry);
            const dateMs = rawRetry === null ? NaN : Date.parse(rawRetry);
            const waitMs = Number.isFinite(seconds)
              ? seconds * 1000
              : Number.isFinite(dateMs)
                ? Math.max(0, dateMs - Date.now())
                : 60_000;
            if (waitMs > 60_000)
              throw new Error(
                "Provider Retry-After exceeds bounded retry budget; resume later",
              );
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(3000, waitMs)),
            );
            continue;
          }
          if (!response.ok)
            throw new Error(
              `Provider replay HTTP ${response.status}; complete failure body retained in report`,
            );
          validateReplayStream(response.rawResponse);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          break;
        }
      }
      process.stderr.write(
        `[wire-replay] completed ${index + 1}/30 matched requests\n`,
      );
    }
    await persist("complete");
  } catch (error) {
    // error-policy:J1 A failed CLI experiment retains every completed attempt and its terminal status.
    await persist("failed", error);
    throw error;
  }
}

// error-policy:J1 CLI failure remains nonzero and prior complete observations stay on disk.
if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
