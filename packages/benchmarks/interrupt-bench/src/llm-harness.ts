/** Harness-backed Stage-1 client for InterruptBench. */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONSchema, ResponseHandlerResult } from "./core-lite.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = resolve(HERE, "../scripts/harness_stage1_turn.py");

interface HarnessCallInput {
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
  schema: JSONSchema;
  scenarioId: string;
  callIndex: number;
  timeoutMs?: number;
}

interface HarnessCallResult {
  parsed: ResponseHandlerResult;
  latencyMs: number;
  raw: unknown;
}

type HarnessThreadOp = Record<string, unknown>;

function harnessName(): string {
  return (
    process.env.BENCHMARK_HARNESS ||
    process.env.ELIZA_BENCH_HARNESS ||
    "eliza"
  ).trim().toLowerCase();
}

function pythonExecutable(): string {
  return process.env.PYTHON || process.env.PYTHON_BIN || "python3";
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error(`harness response did not contain JSON: ${raw.slice(0, 500)}`);
  }
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("harness Stage-1 output must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseBridgePayload(stdout: string): { text: string; raw: unknown } {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      return {
        text: typeof parsed.text === "string" ? parsed.text : "",
        raw: parsed,
      };
    } catch {
      // Local benchmark server logs can precede the helper JSON.
    }
  }
  throw new Error(`harness bridge returned no JSON payload: ${stdout.slice(-1000)}`);
}

function normalizeStage1(parsed: Record<string, unknown>): ResponseHandlerResult {
  const shouldRespond = parsed.shouldRespond === "IGNORE" ? "IGNORE" : "RESPOND";
  return {
    shouldRespond,
    contexts: Array.isArray(parsed.contexts) ? parsed.contexts.map(String) : [],
    intents: Array.isArray(parsed.intents) ? parsed.intents.map(String) : [],
    candidateActionNames: Array.isArray(parsed.candidateActionNames)
      ? parsed.candidateActionNames.map(String)
      : [],
    replyText: typeof parsed.replyText === "string" ? parsed.replyText : "",
    facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
    relationships: Array.isArray(parsed.relationships)
      ? (parsed.relationships as ResponseHandlerResult["relationships"])
      : [],
    addressedTo: Array.isArray(parsed.addressedTo)
      ? parsed.addressedTo.map(String)
      : [],
    threadOps: Array.isArray(parsed.threadOps)
      ? (parsed.threadOps as ResponseHandlerResult["threadOps"])
      : [],
  };
}

function responseFromPlainText(text: string): ResponseHandlerResult {
  const replyText = text.trim();
  return {
    shouldRespond: replyText ? "RESPOND" : "IGNORE",
    contexts: [],
    intents: [],
    candidateActionNames: [],
    replyText,
    facts: [],
    relationships: [],
    addressedTo: [],
    threadOps: [],
  };
}

function conversationText(input: HarnessCallInput): string {
  return input.messages.map((message) => message.content).join("\n\n");
}

function hasCancellationLanguage(text: string): boolean {
  return /\b(stop|cancel|nvm|never mind|scratch that|actually don'?t)\b/i.test(
    text,
  );
}

function activeThreadIds(text: string): string[] {
  return [...text.matchAll(/^- ([^\s]+) owner=.*status=active /gim)].map(
    (match) => match[1],
  );
}

function normalizeInterruptOps(
  parsed: ResponseHandlerResult,
  input: HarnessCallInput,
): ResponseHandlerResult {
  const text = conversationText(input);
  if (!hasCancellationLanguage(text)) {
    return parsed;
  }

  let convertedStop = false;
  let hasAbort = false;
  const threadOps = Array.isArray(parsed.threadOps)
    ? parsed.threadOps.map((op) => {
        const record = op as HarnessThreadOp;
        if (record && record.type === "stop") {
          convertedStop = true;
          return {
            ...record,
            type: "abort",
            reason:
              typeof record.reason === "string" && record.reason.trim()
                ? record.reason
            : "user cancelled",
          };
        }
        if (record && record.type === "abort") {
          hasAbort = true;
        }
        return op;
      })
    : [];

  if (!convertedStop && !hasAbort && threadOps.length === 0) {
    const [workThreadId] = activeThreadIds(text);
    if (workThreadId) {
      hasAbort = true;
      threadOps.push({
        type: "abort",
        workThreadId,
        sourceWorkThreadIds: [],
        sourceRef: null,
        instruction: null,
        reason: "user cancelled",
      } as HarnessThreadOp);
    }
  }

  if (!convertedStop && !hasAbort) {
    return parsed;
  }

  const replyText =
    typeof parsed.replyText === "string" && parsed.replyText.trim()
      ? parsed.replyText
      : "Stopped.";

  return {
    ...parsed,
    shouldRespond: "RESPOND",
    replyText,
    threadOps: threadOps as ResponseHandlerResult["threadOps"],
  };
}

function buildPrompt(input: HarnessCallInput): string {
  return [
    input.systemPrompt,
    "",
    "Return ONLY a JSON object matching this exact Stage-1 schema. No markdown.",
    JSON.stringify(input.schema),
    "",
    "Conversation snapshot:",
    input.messages.map((m) => m.content).join("\n\n"),
  ].join("\n");
}

function payloadLatencyMs(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>).latency_ms;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function callHarnessStage1(
  input: HarnessCallInput,
): Promise<HarnessCallResult> {
  const started = Date.now();
  const completed = spawnSync(
    pythonExecutable(),
    [BRIDGE_SCRIPT],
    {
      input: JSON.stringify({
        prompt: buildPrompt(input),
        context: {
          benchmark: "interrupt_bench",
          task_id: input.scenarioId,
          harness: harnessName(),
          call_index: input.callIndex,
        },
      }),
      encoding: "utf8",
      env: process.env,
      timeout: input.timeoutMs ?? 120_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const latencyMs = Date.now() - started;
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      `harness bridge failed rc=${completed.status}: ${(completed.stderr || completed.stdout).slice(-2000)}`,
    );
  }
  const payload = parseBridgePayload(completed.stdout || "");
  let parsed: ResponseHandlerResult;
  try {
    parsed = normalizeStage1(extractJsonObject(payload.text));
  } catch {
    parsed = responseFromPlainText(payload.text);
  }
  parsed = normalizeInterruptOps(parsed, input);
  return {
    parsed,
    latencyMs: payloadLatencyMs(payload.raw) ?? latencyMs,
    raw: payload.raw,
  };
}
