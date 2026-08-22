/** Validates synthetic-control wire messages without accepting lossy or executable values. */

import type {
  JsonValue,
  SyntheticControlCommand,
  SyntheticControlFailure,
  SyntheticControlRequest,
  SyntheticControlResponse,
} from "./types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length || missing.length) {
    throw new Error(
      `${label} has invalid keys (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`,
    );
  }
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 512
  ) {
    throw new Error(
      `${label} must be a non-empty string of at most 512 characters`,
    );
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  const active = new Set<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new Error(`${path} must be finite`);
      return;
    }
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`${path} must contain JSON-only values`);
    }
    if (active.has(candidate)) throw new Error(`${path} must not be cyclic`);
    active.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
    } else {
      if (Object.getPrototypeOf(candidate) !== Object.prototype) {
        throw new Error(`${path} must contain plain JSON objects`);
      }
      for (const [key, item] of Object.entries(candidate)) {
        visit(item, `${path}.${key}`);
      }
    }
    active.delete(candidate);
  };
  visit(value, label);
}

function manifest(
  value: unknown,
): Extract<SyntheticControlCommand, { type: "seed" }>["manifest"] {
  const item = record(value, "manifest");
  keys(item, ["version", "namespace", "manifestId", "domains"], [], "manifest");
  if (item.version !== 1) throw new Error("manifest.version must be 1");
  const domains = record(item.domains, "manifest.domains");
  assertJsonValue(domains, "manifest.domains");
  return {
    version: 1,
    namespace: text(item.namespace, "manifest.namespace"),
    manifestId: text(item.manifestId, "manifest.manifestId"),
    domains,
  };
}

function receipt(
  value: unknown,
): Extract<SyntheticControlCommand, { type: "reset" }>["receipt"] {
  const item = record(value, "receipt");
  keys(
    item,
    ["version", "namespace", "manifestId", "generation", "receipt"],
    [],
    "receipt",
  );
  if (item.version !== 1) throw new Error("receipt.version must be 1");
  assertJsonValue(item.receipt, "receipt.receipt");
  return {
    version: 1,
    namespace: text(item.namespace, "receipt.namespace"),
    manifestId: text(item.manifestId, "receipt.manifestId"),
    generation: integer(item.generation, "receipt.generation"),
    receipt: item.receipt,
  };
}

function fault(
  value: unknown,
): Extract<SyntheticControlCommand, { type: "fault.install" }>["fault"] {
  const item = record(value, "fault");
  keys(
    item,
    ["id", "scope", "mode", "count"],
    ["operation", "delayMs", "errorCode", "data"],
    "fault",
  );
  const modes = new Set(["delay", "error", "disconnect", "malformed-response"]);
  if (!modes.has(String(item.mode)))
    throw new Error("fault.mode is unsupported");
  if (item.data !== undefined) assertJsonValue(item.data, "fault.data");
  return {
    id: text(item.id, "fault.id"),
    scope: text(item.scope, "fault.scope"),
    mode: item.mode as "delay" | "error" | "disconnect" | "malformed-response",
    count: integer(item.count, "fault.count", 1, 1_000_000),
    ...(item.operation === undefined
      ? {}
      : { operation: text(item.operation, "fault.operation") }),
    ...(item.delayMs === undefined
      ? {}
      : { delayMs: integer(item.delayMs, "fault.delayMs", 0, 3_600_000) }),
    ...(item.errorCode === undefined
      ? {}
      : { errorCode: text(item.errorCode, "fault.errorCode") }),
    ...(item.data === undefined ? {} : { data: item.data }),
  };
}

function command(value: unknown): SyntheticControlCommand {
  const item = record(value, "command");
  const type = text(item.type, "command.type");
  switch (type) {
    case "health":
      keys(item, ["type"], [], "health command");
      return { type };
    case "lease.acquire":
      keys(item, ["type", "owner", "ttlMs"], [], "lease.acquire command");
      return {
        type,
        owner: text(item.owner, "command.owner"),
        ttlMs: integer(item.ttlMs, "command.ttlMs", 1, 86_400_000),
      };
    case "lease.release":
      keys(item, ["type", "leaseId"], [], "lease.release command");
      return { type, leaseId: text(item.leaseId, "command.leaseId") };
    case "seed":
      keys(item, ["type", "manifest"], [], "seed command");
      return { type, manifest: manifest(item.manifest) };
    case "reset":
      keys(item, ["type", "receipt"], [], "reset command");
      return { type, receipt: receipt(item.receipt) };
    case "time.advance":
      keys(item, ["type", "milliseconds"], [], "time.advance command");
      return {
        type,
        milliseconds: integer(
          item.milliseconds,
          "command.milliseconds",
          0,
          31_536_000_000,
        ),
      };
    case "fault.install":
      keys(item, ["type", "fault"], [], "fault.install command");
      return { type, fault: fault(item.fault) };
    case "fault.clear":
    case "snapshot":
      keys(item, ["type"], ["scope"], `${type} command`);
      return {
        type,
        ...(item.scope === undefined
          ? {}
          : { scope: text(item.scope, "command.scope") }),
      };
    case "ledger.query":
      keys(item, ["type"], ["afterSequence", "limit"], "ledger.query command");
      return {
        type,
        ...(item.afterSequence === undefined
          ? {}
          : {
              afterSequence: integer(
                item.afterSequence,
                "command.afterSequence",
              ),
            }),
        ...(item.limit === undefined
          ? {}
          : { limit: integer(item.limit, "command.limit", 1, 10_000) }),
      };
    case "teardown":
      keys(item, ["type", "reason"], [], "teardown command");
      return { type, reason: text(item.reason, "command.reason") };
    default:
      throw new Error(`unsupported command type ${type}`);
  }
}

export function parseSyntheticControlRequest(
  value: unknown,
): SyntheticControlRequest {
  const item = record(value, "request");
  keys(
    item,
    ["version", "commandId", "command"],
    ["expectedGeneration", "leaseId"],
    "request",
  );
  if (item.version !== 1) throw new Error("request.version must be 1");
  return {
    version: 1,
    commandId: text(item.commandId, "request.commandId"),
    command: command(item.command),
    ...(item.expectedGeneration === undefined
      ? {}
      : {
          expectedGeneration: integer(
            item.expectedGeneration,
            "request.expectedGeneration",
          ),
        }),
    ...(item.leaseId === undefined
      ? {}
      : { leaseId: text(item.leaseId, "request.leaseId") }),
  };
}

export function parseSyntheticControlResponse(
  value: unknown,
): SyntheticControlResponse {
  const item = record(value, "response");
  if (item.version !== 1) throw new Error("response.version must be 1");
  const commandId = text(item.commandId, "response.commandId");
  const generation = integer(item.generation, "response.generation");
  if (item.ok === true) {
    keys(
      item,
      ["version", "commandId", "ok", "generation", "data"],
      [],
      "success response",
    );
    assertJsonValue(item.data, "response.data");
    return { version: 1, commandId, ok: true, generation, data: item.data };
  }
  if (item.ok !== false) throw new Error("response.ok must be boolean");
  keys(
    item,
    ["version", "commandId", "ok", "generation", "error"],
    [],
    "failure response",
  );
  const failure = record(item.error, "response.error");
  keys(
    failure,
    ["code", "message", "retryable"],
    ["details"],
    "response.error",
  );
  const codes = new Set<SyntheticControlFailure["error"]["code"]>([
    "AUTH_REQUIRED",
    "INVALID_REQUEST",
    "LEASE_CONFLICT",
    "LEASE_REQUIRED",
    "STALE_GENERATION",
    "COMMAND_FAILED",
    "UNSUPPORTED_COMMAND",
  ]);
  if (!codes.has(failure.code as SyntheticControlFailure["error"]["code"]))
    throw new Error("response.error.code is unsupported");
  if (typeof failure.retryable !== "boolean")
    throw new Error("response.error.retryable must be boolean");
  if (failure.details !== undefined)
    assertJsonValue(failure.details, "response.error.details");
  return {
    version: 1,
    commandId,
    ok: false,
    generation,
    error: {
      code: failure.code as SyntheticControlFailure["error"]["code"],
      message: text(failure.message, "response.error.message"),
      retryable: failure.retryable,
      ...(failure.details === undefined ? {} : { details: failure.details }),
    },
  };
}
