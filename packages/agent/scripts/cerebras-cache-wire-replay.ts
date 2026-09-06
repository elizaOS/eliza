#!/usr/bin/env bun
/**
 * Replays complete captured Cerebras requests with only the optional cache hint changed.
 * This controlled provider experiment is separate from runtime and gateway evidence.
 * Complete SSE responses are retained; credentials and authorization headers are not.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { sourceRevisionEvidence } from "./cerebras-chat-flow-latency.ts";

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
  const finished = events.some(
    (event) =>
      Array.isArray(event.choices) &&
      event.choices.some((choice) => object(choice).finish_reason != null),
  );
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
  const rows: Array<Record<string, unknown>> = [];
  const modes = ["automatic", "shared-prefix", "conversation"] as const;
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
        const startedAt = performance.now();
        const response = await fetch(
          "https://api.cerebras.ai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
          },
        );
        const headersMs = performance.now() - startedAt;
        const rawResponse = await response.text();
        const totalMs = performance.now() - startedAt;
        rows.push({
          index,
          order: offset,
          mode,
          attempt,
          originalContext: context,
          request,
          status: response.status,
          headersMs,
          totalMs,
          rawResponse,
        });
        await writeFile(
          output,
          `${JSON.stringify({ experiment: "matched-complete-wire-provider-replay", status: "running", sourceRevision, sourceReportSha256: createHash("sha256").update(inputBytes).digest("hex"), runId, limitations: "Provider replay only. Shared and conversation keys are run-scoped. Automatic-prefix cache may already be warm. Mode order rotates; independent cache isolation and eviction are not guaranteed.", rows }, null, 2)}\n`,
          { mode: 0o600 },
        );
        if (response.status === 429 && attempt < 3) {
          const rawRetry = response.headers.get("retry-after");
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
        validateReplayStream(rawResponse);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        break;
      }
    }
    process.stderr.write(
      `[wire-replay] completed ${index + 1}/30 matched requests\n`,
    );
  }
  const final = object(JSON.parse(await readFile(output, "utf8")));
  final.status = "complete";
  await writeFile(output, `${JSON.stringify(final, null, 2)}\n`, {
    mode: 0o600,
  });
}

// error-policy:J1 CLI failure remains nonzero and prior complete observations stay on disk.
if (import.meta.main)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
