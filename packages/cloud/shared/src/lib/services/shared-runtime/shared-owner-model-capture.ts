/** Owner-admitted, bounded model/action payloads. Never logs or enables capture. */
import { isSensitiveKeyName, redactSensitiveText } from "@elizaos/core";

export interface OwnerCaptureScope {
  organizationId: string;
  userId: string;
  roomId: string;
  traceId: string;
}

export interface OwnerCaptureLimits {
  maxCalls: number;
  maxBytes: number;
  expiresAt: number;
}

export interface OwnerCaptureEvent {
  ordinal: number;
  kind:
    | "sdk-request"
    | "sdk-result"
    | "model-timing"
    | "action-gate"
    | "action-started"
    | "action-completed"
    | "action-omitted"
    | "core-result"
    | "runtime-timing"
    | "preflight"
    | "final-delivery";
  payload: unknown;
}

export interface OwnerCapturePayload {
  version: 1;
  scope: OwnerCaptureScope;
  events: OwnerCaptureEvent[];
  coverage: {
    /** Completeness of captured SDK/executor IO; transport delivery is a separately joined receipt. */
    exactFull: boolean;
    redactedFields: number;
    redactedStrings: number;
    omittedFields: number;
    omittedEvents: number;
    callsObserved: number;
    callsCaptured: number;
    pendingCalls: number;
    pendingTimings: number;
    toolExecutionsStarted: number;
    toolExecutionsSettled: number;
    pendingToolExecutions: number;
    expired: boolean;
    actionArguments: "unavailable" | "canonical-observer";
  };
  usageCoverage: {
    state: "complete" | "partial" | "unknown";
    knownCalls: number;
    unknownCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    knownInputTokens: number;
    knownOutputTokens: number;
    knownTotalTokens: number;
  };
}

export interface OwnerModelCapture {
  /** Only projected SDK inputs: never a model object, Request, headers or signal. */
  request(payload: unknown): number | undefined;
  result(call: number | undefined, payload: unknown): void;
  modelTiming(call: number | undefined, payload: unknown): void;
  observe(
    kind: Exclude<OwnerCaptureEvent["kind"], "sdk-request" | "sdk-result">,
    payload: unknown,
  ): void;
  /** A canonical observer must explicitly attest post-validation executed arguments. */
  canonicalActionArgumentsAvailable(): void;
  omission(): void;
  protectSecrets(redact: (text: string) => string, values: readonly string[]): void;
  canonicalTool(payload: {
    executionId?: string;
    phase: string;
    redactedFields: number;
    redactedStrings: number;
    omittedFields: number;
  }): void;
  snapshot(): OwnerCapturePayload;
  finish(payload: unknown): void;
}

/** Isolates injected synchronous or asynchronous observers without delaying inference. */
export function observeOwnerCapture(
  capture: OwnerModelCapture | undefined,
  observe: (value: OwnerModelCapture) => unknown,
): void {
  if (!capture) return;
  try {
    const returned = observe(capture);
    if (returned !== undefined) void Promise.resolve(returned).catch(() => {});
  } catch {
    try {
      const returned: unknown = capture.omission();
      if (returned !== undefined) void Promise.resolve(returned).catch(() => {});
    } catch {
      /* Private capture never replaces an original execution outcome. */
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseOwnerCapturePayload(value: unknown): OwnerCapturePayload | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.scope) ||
    !isRecord(value.coverage) ||
    !Array.isArray(value.events) ||
    value.events.length > 256
  )
    return undefined;
  const scope = value.scope;
  if (
    ![scope.organizationId, scope.userId, scope.roomId, scope.traceId].every(
      (part) => typeof part === "string",
    )
  )
    return undefined;
  const coverage = value.coverage;
  if (
    typeof coverage.exactFull !== "boolean" ||
    typeof coverage.expired !== "boolean" ||
    !["unavailable", "canonical-observer"].includes(String(coverage.actionArguments))
  )
    return undefined;
  for (const field of [
    "redactedFields",
    "redactedStrings",
    "omittedFields",
    "omittedEvents",
    "callsObserved",
    "callsCaptured",
    "pendingCalls",
    "pendingTimings",
    "toolExecutionsStarted",
    "toolExecutionsSettled",
    "pendingToolExecutions",
  ] as const) {
    if (
      typeof coverage[field] !== "number" ||
      !Number.isSafeInteger(coverage[field]) ||
      coverage[field] < 0
    )
      return undefined;
  }
  const events: OwnerCaptureEvent[] = [];
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      typeof event.ordinal !== "number" ||
      !Number.isSafeInteger(event.ordinal) ||
      event.ordinal < 1
    )
      return undefined;
    if (
      event.kind !== "sdk-request" &&
      event.kind !== "sdk-result" &&
      event.kind !== "model-timing" &&
      event.kind !== "action-gate" &&
      event.kind !== "action-started" &&
      event.kind !== "action-completed" &&
      event.kind !== "action-omitted" &&
      event.kind !== "core-result" &&
      event.kind !== "runtime-timing" &&
      event.kind !== "preflight" &&
      event.kind !== "final-delivery"
    )
      return undefined;
    events.push({
      ordinal: event.ordinal,
      kind: event.kind,
      payload: event.payload,
    });
  }
  if (!isRecord(value.usageCoverage)) return undefined;
  const usage = value.usageCoverage;
  if (usage.state !== "complete" && usage.state !== "partial" && usage.state !== "unknown")
    return undefined;
  for (const field of [
    "knownCalls",
    "unknownCalls",
    "knownInputTokens",
    "knownOutputTokens",
    "knownTotalTokens",
  ] as const) {
    if (typeof usage[field] !== "number" || !Number.isSafeInteger(usage[field]) || usage[field] < 0)
      return undefined;
  }
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (
      usage[field] !== null &&
      (typeof usage[field] !== "number" || !Number.isSafeInteger(usage[field]) || usage[field] < 0)
    )
      return undefined;
  }
  return {
    version: 1,
    scope: {
      organizationId: String(scope.organizationId),
      userId: String(scope.userId),
      roomId: String(scope.roomId),
      traceId: String(scope.traceId),
    },
    events,
    coverage: {
      exactFull: coverage.exactFull,
      expired: coverage.expired,
      actionArguments:
        coverage.actionArguments === "canonical-observer" ? "canonical-observer" : "unavailable",
      redactedFields: Number(coverage.redactedFields),
      redactedStrings: Number(coverage.redactedStrings),
      omittedFields: Number(coverage.omittedFields),
      omittedEvents: Number(coverage.omittedEvents),
      callsObserved: Number(coverage.callsObserved),
      callsCaptured: Number(coverage.callsCaptured),
      pendingCalls: Number(coverage.pendingCalls),
      pendingTimings: Number(coverage.pendingTimings),
      toolExecutionsStarted: Number(coverage.toolExecutionsStarted),
      toolExecutionsSettled: Number(coverage.toolExecutionsSettled),
      pendingToolExecutions: Number(coverage.pendingToolExecutions),
    },
    usageCoverage: {
      state: usage.state,
      knownCalls: Number(usage.knownCalls),
      unknownCalls: Number(usage.unknownCalls),
      inputTokens: usage.inputTokens === null ? null : Number(usage.inputTokens),
      outputTokens: usage.outputTokens === null ? null : Number(usage.outputTokens),
      totalTokens: usage.totalTokens === null ? null : Number(usage.totalTokens),
      knownInputTokens: Number(usage.knownInputTokens),
      knownOutputTokens: Number(usage.knownOutputTokens),
      knownTotalTokens: Number(usage.knownTotalTokens),
    },
  };
}

const MAX_CALL_BYTES = 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 30_000;
const encoder = new TextEncoder();
const reasoningKeys = new Set([
  "reasoning",
  "reasoningtext",
  "reasoning_text",
  "thought",
  "analysis",
  "scratchpad",
  "chainofthought",
  "chain_of_thought",
]);
const forbidden = new Set([
  "authorization",
  "headers",
  "rawresponse",
  "rawrequest",
  ...reasoningKeys,
  "signal",
  "execute",
  "__proto__",
  "prototype",
  "constructor",
]);

/** No provider I/O. Sink must be the reviewed encrypted owner store, not a logger. */
export function createOwnerCaptureBuffer(
  scope: OwnerCaptureScope,
  limits: OwnerCaptureLimits,
  persist: (payload: OwnerCapturePayload) => void,
  now: () => number = Date.now,
): OwnerModelCapture {
  scope = Object.freeze({ ...scope });
  limits = Object.freeze({ ...limits });
  const events: OwnerCaptureEvent[] = [];
  const coverage: OwnerCapturePayload["coverage"] = {
    exactFull: false,
    redactedFields: 0,
    redactedStrings: 0,
    omittedFields: 0,
    omittedEvents: 0,
    callsObserved: 0,
    callsCaptured: 0,
    expired: false,
    pendingCalls: 0,
    pendingTimings: 0,
    toolExecutionsStarted: 0,
    toolExecutionsSettled: 0,
    pendingToolExecutions: 0,
    actionArguments: "unavailable",
  };
  let totalBytes = 0;
  let finished = false;
  let eventOrdinal = 0;
  const capturedCalls = new Set<number>();
  const completedCalls = new Set<number>();
  const timedCalls = new Set<number>();
  const startedTools = new Set<string>();
  const settledTools = new Set<string>();
  let secretProtectionUnavailable = false;
  let secretRedactor: ((text: string) => string) | undefined;
  const knownSecrets = new Set<string>();
  const markOmitted = () => {
    coverage.omittedFields += 1;
  };

  function clone(
    value: unknown,
    budget: { bytes: number; nodes: number },
    depth = 0,
    schemaMode: "value" | "schema" | "definitions" = "value",
  ): unknown {
    if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) {
      markOmitted();
      return "[omitted: structure limit]";
    }
    if (value === null || typeof value === "boolean" || value === undefined) return value ?? null;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        markOmitted();
        return null;
      }
      return value;
    }
    if (typeof value === "string") {
      if (secretProtectionUnavailable) {
        markOmitted();
        return "[omitted: secret projection unavailable]";
      }
      if (value.length > MAX_CALL_BYTES) {
        markOmitted();
        return "[omitted: byte limit]";
      }
      const bytes = encoder.encode(value).byteLength;
      if (bytes > MAX_CALL_BYTES || budget.bytes + bytes > MAX_CALL_BYTES) {
        markOmitted();
        return "[omitted: byte limit]";
      }
      budget.bytes += bytes;
      // Never retain even the credential fragments kept by display redaction.
      if (
        redactSensitiveText(value) !== value ||
        (secretRedactor && secretRedactor(value) !== value) ||
        [...knownSecrets].some((secret) => value.includes(secret))
      ) {
        coverage.redactedStrings += 1;
        return "[credential redacted]";
      }
      return value;
    }
    if (typeof value !== "object") {
      markOmitted();
      return "[omitted: non-JSON value]";
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_NODES) markOmitted();
      return Object.freeze(
        value.slice(0, MAX_NODES).map((part) => clone(part, budget, depth + 1, schemaMode)),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      markOmitted();
      return "[omitted: non-JSON object]";
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      descriptors.type?.value === "reasoning" ||
      descriptors.type?.value === "redacted-reasoning"
    ) {
      coverage.redactedFields += 1;
      return "[hidden reasoning excluded]";
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if ("value" in descriptor && descriptor.value === undefined) continue;
      const numericRequestBudget =
        key === "maxOutputTokens" &&
        typeof descriptor.value === "number" &&
        Number.isSafeInteger(descriptor.value);
      const schemaIdentifier = schemaMode === "definitions";
      if (
        !schemaIdentifier &&
        (forbidden.has(key.toLowerCase()) || (!numericRequestBudget && isSensitiveKeyName(key)))
      ) {
        coverage.redactedFields += 1;
        continue;
      }
      if (!("value" in descriptor)) {
        markOmitted();
        continue;
      }
      budget.bytes += encoder.encode(key).byteLength + 4;
      if (budget.bytes > MAX_CALL_BYTES) {
        markOmitted();
        break;
      }
      const nextSchemaMode =
        schemaMode === "definitions" || key === "inputSchema"
          ? "schema"
          : schemaMode === "schema" &&
              [
                "properties",
                "patternProperties",
                "$defs",
                "definitions",
                "dependentSchemas",
              ].includes(key)
            ? "definitions"
            : schemaMode === "schema" &&
                [
                  "items",
                  "prefixItems",
                  "additionalProperties",
                  "allOf",
                  "anyOf",
                  "oneOf",
                  "not",
                  "if",
                  "then",
                  "else",
                  "contains",
                ].includes(key)
              ? "schema"
              : "value";
      if (
        (key === "visibleText" || (key === "content" && descriptors.role?.value === "assistant")) &&
        typeof descriptor.value === "string" &&
        descriptor.value.length <= MAX_CALL_BYTES &&
        encoder.encode(descriptor.value).byteLength <= MAX_CALL_BYTES &&
        /^[\s]*[[{]/.test(descriptor.value)
      ) {
        try {
          const parsed: unknown = JSON.parse(descriptor.value);
          let inspected = 0;
          let uninspected = false;
          const hasReasoning = (part: unknown, level = 0): boolean => {
            if (++inspected > MAX_NODES || level > MAX_DEPTH) {
              uninspected = true;
              return false;
            }
            if (part === null || typeof part !== "object") return false;
            if (Array.isArray(part)) {
              if (part.length > MAX_NODES) uninspected = true;
              return part.slice(0, MAX_NODES).some((item) => hasReasoning(item, level + 1));
            }
            for (const [name, item] of Object.entries(part)) {
              if (inspected > MAX_NODES) {
                uninspected = true;
                break;
              }
              if (reasoningKeys.has(name.toLowerCase()) || hasReasoning(item, level + 1))
                return true;
            }
            return false;
          };
          if (hasReasoning(parsed) || uninspected) {
            markOmitted();
            result[key] = Object.freeze({
              encoding: "structured-json",
              rawTextOmittedForHiddenReasoning: true,
              value: clone(parsed, budget, depth + 1),
            });
            continue;
          }
        } catch {
          /* Ordinary returned text remains text; no prompt classification. */
        }
      }
      result[key] = clone(descriptor.value, budget, depth + 1, nextSchemaMode);
    }
    return Object.freeze(result);
  }

  function append(kind: OwnerCaptureEvent["kind"], payload: unknown): boolean {
    if (finished) return false;
    if (now() >= limits.expiresAt) {
      coverage.expired = true;
      coverage.omittedEvents += 1;
      return false;
    }
    if (events.length >= 256) {
      coverage.omittedEvents += 1;
      return false;
    }
    try {
      const projected = clone(payload, { bytes: 0, nodes: 0 });
      const event: OwnerCaptureEvent = {
        ordinal: ++eventOrdinal,
        kind,
        payload: projected,
      };
      const bytes = encoder.encode(JSON.stringify(event)).byteLength;
      if (bytes > MAX_CALL_BYTES || totalBytes + bytes > limits.maxBytes - 16_384) {
        coverage.omittedEvents += 1;
        return false;
      }
      totalBytes += bytes;
      events.push(event);
      return true;
    } catch {
      coverage.omittedEvents += 1;
      return false;
    }
  }

  const snapshot = (): OwnerCapturePayload => {
    const copiedCoverage = { ...coverage };
    copiedCoverage.pendingCalls = capturedCalls.size - completedCalls.size;
    copiedCoverage.pendingTimings = capturedCalls.size - timedCalls.size;
    copiedCoverage.toolExecutionsStarted = startedTools.size;
    copiedCoverage.toolExecutionsSettled = settledTools.size;
    copiedCoverage.pendingToolExecutions = [...startedTools].filter(
      (id) => !settledTools.has(id),
    ).length;
    copiedCoverage.exactFull =
      !copiedCoverage.expired &&
      copiedCoverage.redactedFields === 0 &&
      copiedCoverage.redactedStrings === 0 &&
      copiedCoverage.omittedFields === 0 &&
      copiedCoverage.omittedEvents === 0 &&
      copiedCoverage.callsCaptured === copiedCoverage.callsObserved &&
      completedCalls.size === capturedCalls.size &&
      copiedCoverage.actionArguments === "canonical-observer" &&
      copiedCoverage.pendingToolExecutions === 0 &&
      copiedCoverage.pendingTimings === 0;
    let knownCalls = 0;
    let knownInputTokens = 0;
    let knownOutputTokens = 0;
    let knownTotalTokens = 0;
    let inputKnown = 0;
    let outputKnown = 0;
    let totalKnown = 0;
    const count = (value: unknown): value is number =>
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 1_000_000_000;
    for (const event of events) {
      if (
        event.kind !== "sdk-result" ||
        !isRecord(event.payload) ||
        !isRecord(event.payload.output) ||
        !isRecord(event.payload.output.usage)
      )
        continue;
      const usage = event.payload.output.usage;
      if (count(usage.inputTokens)) {
        knownInputTokens += usage.inputTokens;
        inputKnown += 1;
      }
      if (count(usage.outputTokens)) {
        knownOutputTokens += usage.outputTokens;
        outputKnown += 1;
      }
      if (count(usage.totalTokens)) {
        knownTotalTokens += usage.totalTokens;
        totalKnown += 1;
      }
      if (count(usage.inputTokens) && count(usage.outputTokens) && count(usage.totalTokens))
        knownCalls += 1;
    }
    const observed = copiedCoverage.callsObserved;
    const complete = knownCalls === observed;
    copiedCoverage.exactFull &&= complete;
    const usageCoverage: OwnerCapturePayload["usageCoverage"] = {
      state: complete
        ? "complete"
        : inputKnown + outputKnown + totalKnown > 0
          ? "partial"
          : "unknown",
      knownCalls,
      unknownCalls: observed - knownCalls,
      inputTokens:
        inputKnown === observed && Number.isSafeInteger(knownInputTokens) ? knownInputTokens : null,
      outputTokens:
        outputKnown === observed && Number.isSafeInteger(knownOutputTokens)
          ? knownOutputTokens
          : null,
      totalTokens:
        totalKnown === observed && Number.isSafeInteger(knownTotalTokens) ? knownTotalTokens : null,
      knownInputTokens,
      knownOutputTokens,
      knownTotalTokens,
    };
    return {
      version: 1,
      scope: { ...scope },
      events: events.map((event) => ({ ...event })),
      coverage: copiedCoverage,
      usageCoverage,
    };
  };
  return {
    request(payload) {
      coverage.callsObserved += 1;
      if (coverage.callsObserved > limits.maxCalls) {
        coverage.omittedEvents += 1;
        return undefined;
      }
      const call = coverage.callsObserved;
      if (!append("sdk-request", { call, input: payload })) return undefined;
      capturedCalls.add(call);
      coverage.callsCaptured += 1;
      return call;
    },
    result(call, payload) {
      if (call === undefined || !capturedCalls.has(call) || completedCalls.has(call)) return;
      if (append("sdk-result", { call, output: payload })) completedCalls.add(call);
    },
    modelTiming(call, payload) {
      if (call === undefined || !capturedCalls.has(call) || timedCalls.has(call)) return;
      if (append("model-timing", { call, timing: payload })) timedCalls.add(call);
    },
    observe: append,
    canonicalActionArgumentsAvailable() {
      coverage.actionArguments = "canonical-observer";
    },
    omission: markOmitted,
    protectSecrets(redact, values) {
      if (finished) return;
      secretRedactor = redact;
      for (const value of values) {
        if (!value) continue;
        if (knownSecrets.size >= 128 || value.length > 8192) {
          secretProtectionUnavailable = true;
          markOmitted();
          continue;
        }
        knownSecrets.add(value);
      }
    },
    canonicalTool(payload) {
      if (finished) return;
      if (payload.phase === "started" || payload.phase === "settled") {
        const id = payload.executionId;
        if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) markOmitted();
        else if (payload.phase === "started") {
          if (startedTools.has(id)) markOmitted();
          startedTools.add(id);
        } else {
          if (!startedTools.has(id) || settledTools.has(id)) markOmitted();
          settledTools.add(id);
        }
      }
      coverage.redactedFields += payload.redactedFields;
      coverage.redactedStrings += payload.redactedStrings;
      coverage.omittedFields += payload.omittedFields;
      append(
        payload.phase === "started"
          ? "action-started"
          : payload.phase === "gate"
            ? "action-gate"
            : payload.phase === "omitted"
              ? "action-omitted"
              : "action-completed",
        payload,
      );
    },
    snapshot,
    finish(payload) {
      if (finished) return;
      append("final-delivery", payload);
      const captured = snapshot();
      finished = true;
      try {
        const returned: unknown = persist(captured);
        if (returned !== undefined) void Promise.resolve(returned).catch(() => {});
      } catch {
        /* Capture cannot alter turn or delivery semantics. */
      }
    },
  };
}
