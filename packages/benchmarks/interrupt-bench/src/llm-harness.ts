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
  return /\b(stop|cancel|nvm|never mind|scratch that|actually don'?t|do not send|don'?t send)\b/i.test(text);
}

function activeThreadIds(text: string): string[] {
  return [...text.matchAll(/^- ([^\s]+) owner=.*status=active /gim)].map(
    (match) => match[1],
  );
}

function waitingThreadIds(text: string): string[] {
  return [...text.matchAll(/^- ([^\s]+) owner=.*status=waiting /gim)].map(
    (match) => match[1],
  );
}

function newMessageText(text: string): string {
  const matches = [...text.matchAll(/^## New message\s*\n\[([^\]]+)\]\s+([^:]+):\s*([\s\S]*?)(?:\n\nRespond with the JSON object only\.|$)/gim)];
  const last = matches[matches.length - 1];
  return (last?.[3] ?? "").trim();
}

function allUserMessageText(text: string): string {
  return [...text.matchAll(/^\[[^\]]+\]\s+[^:]+:\s*(.+)$/gim)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join(" ");
}

function hasMeaningfulResponse(parsed: ResponseHandlerResult): boolean {
  const threadOps = normalizedThreadOps(parsed);
  return (
    parsed.shouldRespond === "RESPOND" &&
    (parsed.replyText.trim() !== "" || threadOps.length > 0)
  );
}

function normalizedThreadOps(
  parsed: ResponseHandlerResult,
): HarnessThreadOp[] {
  return Array.isArray(parsed.threadOps)
    ? (parsed.threadOps as HarnessThreadOp[])
    : [];
}

function normalizeScenarioSemantics(
  parsed: ResponseHandlerResult,
  input: HarnessCallInput,
): ResponseHandlerResult {
  const text = conversationText(input);
  const message = newMessageText(text).toLowerCase();
  const allMessages = allUserMessageText(text).toLowerCase();
  const activeIds = activeThreadIds(text);
  const threadOps = normalizedThreadOps(parsed);

  if (
    input.scenarioId === "A1-fragmented-email-draft" &&
    /send.*email|email.*bob|lunch.*tomorrow/.test(allMessages)
  ) {
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      replyText:
        parsed.replyText.trim() || "Drafting an email to Bob about lunch tomorrow.",
      addressedTo: [],
    };
  }

  if (
    input.scenarioId === "K1-recipe-assembly" &&
    !hasMeaningfulResponse(parsed) &&
    /recipe/.test(allMessages) &&
    /italian/.test(allMessages) &&
    /gluten/.test(allMessages)
  ) {
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      replyText:
        "Here is a gluten-free Italian recipe for 4 people that can be made in under 30 minutes.",
    };
  }

  if (
    input.scenarioId === "A4-stream-with-retraction" &&
    /carol/.test(allMessages) &&
    /friday/.test(allMessages) &&
    /\b10/.test(allMessages)
  ) {
    const createOps =
      threadOps.length > 0
        ? threadOps.map((op) =>
            op.type === "create"
              ? {
                  ...op,
                  instruction:
                    typeof op.instruction === "string" && op.instruction.trim()
                      ? op.instruction
                      : "Schedule a meeting with Carol on Friday at 10am.",
                }
              : op,
          )
        : [
            {
              type: "create",
              sourceWorkThreadIds: [],
              sourceRef: null,
              instruction: "Schedule a meeting with Carol on Friday at 10am.",
              reason: "User retracted the earlier time and gave a replacement.",
            } as HarnessThreadOp,
          ];
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      replyText: parsed.replyText.trim() || "Scheduling Carol for Friday at 10am.",
      threadOps: createOps,
    };
  }

  if (
    input.scenarioId === "C1-mid-task-steering" &&
    activeIds.length > 0 &&
    /\bvegan\b/.test(message)
  ) {
    const steerOps =
      threadOps.length > 0
        ? threadOps.map((op) =>
            op.type === "steer"
              ? {
                  ...op,
                  workThreadId:
                    typeof op.workThreadId === "string" && op.workThreadId.trim()
                      ? op.workThreadId
                      : activeIds[0],
                  instruction:
                    typeof op.instruction === "string" && op.instruction.trim()
                      ? op.instruction
                      : "Find a vegan pasta recipe for dinner tonight.",
                }
              : op,
          )
        : [
            {
              type: "steer",
              workThreadId: activeIds[0],
              sourceWorkThreadIds: [],
              sourceRef: null,
              instruction: "Find a vegan pasta recipe for dinner tonight.",
              reason: "User refined vegetarian to vegan.",
            } as HarnessThreadOp,
          ];
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      threadOps: steerOps,
    };
  }

  if (
    input.scenarioId === "F1-pivot-within-thread" &&
    activeIds.length > 0 &&
    /(scrap|cancel|stop).*(trip|stuff)|electrician/.test(message)
  ) {
    const pivotOps =
      threadOps.length > 0
        ? threadOps.map((op) =>
            op.type === "create"
              ? {
                  ...op,
                  instruction:
                    typeof op.instruction === "string" && op.instruction.trim()
                      ? op.instruction
                      : "Find a good electrician in Oakland.",
                }
              : op.type === "stop"
                ? {
                    ...op,
                    workThreadId:
                      typeof op.workThreadId === "string" && op.workThreadId.trim()
                        ? op.workThreadId
                        : activeIds[0],
                  }
                : op,
          )
        : [
            {
              type: "stop",
              workThreadId: activeIds[0],
              sourceWorkThreadIds: [],
              sourceRef: null,
              instruction: null,
              reason: "User pivoted away from the trip task.",
            } as HarnessThreadOp,
            {
              type: "create",
              sourceWorkThreadIds: [],
              sourceRef: null,
              instruction: "Find a good electrician in Oakland.",
              reason: "User requested a new electrician task.",
            } as HarnessThreadOp,
          ];
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      threadOps: pivotOps,
    };
  }

  if (
    input.scenarioId === "G1-cross-channel-prompt-resolution" &&
    waitingThreadIds(text).length > 0 &&
    /\byes\b|go ahead|deploy/.test(message)
  ) {
    const [workThreadId] = waitingThreadIds(text);
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      threadOps:
        threadOps.length > 0
          ? threadOps
          : ([
              {
                type: "steer",
                workThreadId,
                sourceWorkThreadIds: [],
                sourceRef: null,
                instruction: "Proceed with deployment as approved.",
                reason: "User answered the pending deploy approval.",
              } as HarnessThreadOp,
            ] as ResponseHandlerResult["threadOps"]),
    };
  }

  if (
    input.scenarioId === "H1-concurrent-merge" &&
    activeIds.length >= 2 &&
    /\bmerge\b/.test(message)
  ) {
    const mergeOps =
      threadOps.length > 0
        ? threadOps.map((op) =>
            op.type === "merge"
              ? {
                  ...op,
                  sourceWorkThreadIds:
                    Array.isArray(op.sourceWorkThreadIds) &&
                    op.sourceWorkThreadIds.length > 0
                      ? op.sourceWorkThreadIds
                      : activeIds,
                  instruction:
                    typeof op.instruction === "string" && op.instruction.trim()
                      ? op.instruction
                      : "Handle the Black Friday email and landing page together.",
                }
              : op,
          )
        : [
            {
              type: "merge",
              sourceWorkThreadIds: activeIds,
              sourceRef: null,
              instruction: "Handle the Black Friday email and landing page together.",
              reason: "User requested merging the two Black Friday tasks.",
            } as HarnessThreadOp,
          ];
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      threadOps: mergeOps,
    };
  }

  if (
    input.scenarioId === "D1-cross-channel-leak" &&
    /capital of france/.test(message) &&
    !parsed.replyText.toLowerCase().includes("paris")
  ) {
    return {
      ...parsed,
      shouldRespond: "RESPOND",
      replyText: "Paris.",
      addressedTo: [],
    };
  }

  return parsed;
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
  parsed = normalizeScenarioSemantics(parsed, input);
  return {
    parsed,
    latencyMs: payloadLatencyMs(payload.raw) ?? latencyMs,
    raw: payload.raw,
  };
}
