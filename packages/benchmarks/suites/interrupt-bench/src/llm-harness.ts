/** Harness-backed Stage-1 client for InterruptBench. */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JSONSchema, ResponseHandlerResult } from "./core-lite.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = resolve(HERE, "../scripts/harness_stage1_turn.py");
// The bridge imports `eliza_adapter`, which lives in harnesses/eliza at the repo root.
const ELIZA_HARNESS_DIR = resolve(HERE, "../../../harnesses/eliza");

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

function harnessName(): string {
  return (
    process.env.BENCHMARK_HARNESS ||
    process.env.ELIZA_BENCH_HARNESS ||
    "eliza"
  )
    .trim()
    .toLowerCase();
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
    throw new Error(
      `harness response did not contain JSON: ${raw.slice(0, 500)}`,
    );
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
  throw new Error(
    `harness bridge returned no JSON payload: ${stdout.slice(-1000)}`,
  );
}

export function decodeHarnessStage1(
  parsed: Record<string, unknown>,
): ResponseHandlerResult {
  if (parsed.shouldRespond !== "RESPOND" && parsed.shouldRespond !== "IGNORE") {
    throw new Error("harness Stage-1 shouldRespond must be RESPOND or IGNORE");
  }
  if (typeof parsed.replyText !== "string") {
    throw new Error("harness Stage-1 replyText must be a string");
  }
  const stringArray = (key: string): string[] => {
    const value = parsed[key];
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new Error(`harness Stage-1 ${key} must be an array of strings`);
    }
    return value;
  };
  if (!Array.isArray(parsed.relationships)) {
    throw new Error("harness Stage-1 relationships must be an array");
  }
  const relationships = parsed.relationships.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`harness Stage-1 relationships[${index}] must be an object`);
    }
    const relationship = value as Record<string, unknown>;
    if (
      typeof relationship.subject !== "string" ||
      typeof relationship.predicate !== "string" ||
      typeof relationship.object !== "string"
    ) {
      throw new Error(
        `harness Stage-1 relationships[${index}] must contain string subject, predicate, and object`,
      );
    }
    return {
      subject: relationship.subject,
      predicate: relationship.predicate,
      object: relationship.object,
    };
  });
  if (!Array.isArray(parsed.threadOps)) {
    throw new Error("harness Stage-1 threadOps must be an array");
  }
  const threadOps = parsed.threadOps.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`harness Stage-1 threadOps[${index}] must be an object`);
    }
    const op = value as Record<string, unknown>;
    if (typeof op.type !== "string") {
      throw new Error(`harness Stage-1 threadOps[${index}].type must be a string`);
    }
    if (op.workThreadId !== null && typeof op.workThreadId !== "string") {
      throw new Error(
        `harness Stage-1 threadOps[${index}].workThreadId must be a string or null`,
      );
    }
    if (
      !Array.isArray(op.sourceWorkThreadIds) ||
      !op.sourceWorkThreadIds.every((item) => typeof item === "string")
    ) {
      throw new Error(
        `harness Stage-1 threadOps[${index}].sourceWorkThreadIds must be an array of strings`,
      );
    }
    if (
      op.sourceRef !== null &&
      (!op.sourceRef ||
        typeof op.sourceRef !== "object" ||
        Array.isArray(op.sourceRef) ||
        typeof (op.sourceRef as Record<string, unknown>).kind !== "string" ||
        typeof (op.sourceRef as Record<string, unknown>).id !== "string")
    ) {
      throw new Error(
        `harness Stage-1 threadOps[${index}].sourceRef must contain string kind and id or be null`,
      );
    }
    if (op.instruction !== null && typeof op.instruction !== "string") {
      throw new Error(
        `harness Stage-1 threadOps[${index}].instruction must be a string or null`,
      );
    }
    if (op.reason !== null && typeof op.reason !== "string") {
      throw new Error(
        `harness Stage-1 threadOps[${index}].reason must be a string or null`,
      );
    }
    return op;
  });
  return {
    shouldRespond: parsed.shouldRespond,
    contexts: stringArray("contexts"),
    intents: stringArray("intents"),
    candidateActionNames: stringArray("candidateActionNames"),
    replyText: parsed.replyText,
    facts: stringArray("facts"),
    relationships,
    addressedTo: stringArray("addressedTo"),
    threadOps: threadOps as ResponseHandlerResult["threadOps"],
  };
}

export function decodeHarnessStage1Text(text: string): ResponseHandlerResult {
  return decodeHarnessStage1(extractJsonObject(text));
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export async function callHarnessStage1(
  input: HarnessCallInput,
): Promise<HarnessCallResult> {
  const started = Date.now();
  const completed = spawnSync(pythonExecutable(), [BRIDGE_SCRIPT], {
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
    env: {
      ...process.env,
      PYTHONPATH: [ELIZA_HARNESS_DIR, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(":"),
    },
    timeout: input.timeoutMs ?? 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const latencyMs = Date.now() - started;
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(
      `harness bridge failed rc=${completed.status}: ${(completed.stderr || completed.stdout).slice(-2000)}`,
    );
  }
  const payload = parseBridgePayload(completed.stdout || "");
  const parsed = decodeHarnessStage1Text(payload.text);
  return {
    parsed,
    latencyMs: payloadLatencyMs(payload.raw) ?? latencyMs,
    raw: payload.raw,
  };
}
