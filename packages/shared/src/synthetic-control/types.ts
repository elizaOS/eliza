/** Defines the versioned, JSON-only control contract shared by mock subprocesses and their test harnesses. */

export const SYNTHETIC_CONTROL_VERSION = 1 as const;
export const SYNTHETIC_CONTROL_PATH = "/__eliza/synthetic-control/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface SyntheticManifest {
  version: 1;
  namespace: string;
  manifestId: string;
  domains: Readonly<Record<string, JsonValue>>;
}

export interface SyntheticResetReceipt {
  version: 1;
  namespace: string;
  manifestId: string;
  generation: number;
  receipt: JsonValue;
}

export interface SyntheticFault {
  id: string;
  scope: string;
  operation?: string;
  mode: "delay" | "error" | "disconnect" | "malformed-response";
  count: number;
  delayMs?: number;
  errorCode?: string;
  data?: JsonValue;
}

export type SyntheticControlCommand =
  | { type: "health" }
  | { type: "lease.acquire"; owner: string; ttlMs: number }
  | { type: "lease.release"; leaseId: string }
  | { type: "seed"; manifest: SyntheticManifest }
  | { type: "reset"; receipt: SyntheticResetReceipt }
  | { type: "time.advance"; milliseconds: number }
  | { type: "fault.install"; fault: SyntheticFault }
  | { type: "fault.clear"; scope?: string }
  | { type: "snapshot"; scope?: string }
  | { type: "ledger.query"; afterSequence?: number; limit?: number }
  /** Authority must invalidate the supplied active lease before acknowledging teardown. */
  | { type: "teardown"; reason: string };

export interface SyntheticControlRequest {
  version: 1;
  commandId: string;
  expectedGeneration?: number;
  leaseId?: string;
  command: SyntheticControlCommand;
}

export interface SyntheticControlSuccess {
  version: 1;
  commandId: string;
  ok: true;
  generation: number;
  data: JsonValue;
}

export interface SyntheticControlFailure {
  version: 1;
  commandId: string;
  ok: false;
  generation: number;
  error: {
    code:
      | "AUTH_REQUIRED"
      | "INVALID_REQUEST"
      | "LEASE_CONFLICT"
      | "LEASE_REQUIRED"
      | "STALE_GENERATION"
      | "COMMAND_FAILED"
      | "UNSUPPORTED_COMMAND";
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
}

export type SyntheticControlResponse =
  | SyntheticControlSuccess
  | SyntheticControlFailure;

export interface SyntheticControlExecutionContext {
  commandId: string;
  expectedGeneration?: number;
  leaseId?: string;
  signal: AbortSignal;
}

/** The production owner implements this boundary; the protocol never persists a second state copy. */
export interface SyntheticControlAuthority {
  generation(): number | Promise<number>;
  execute(
    command: SyntheticControlCommand,
    context: SyntheticControlExecutionContext,
  ): Promise<JsonValue>;
}

export class SyntheticControlProtocolError extends Error {
  readonly code: SyntheticControlFailure["error"]["code"];
  readonly retryable: boolean;
  readonly details?: JsonValue;
  readonly generation?: number;

  constructor(options: {
    code: SyntheticControlFailure["error"]["code"];
    message: string;
    retryable?: boolean;
    details?: JsonValue;
    generation?: number;
  }) {
    super(options.message);
    this.name = "SyntheticControlProtocolError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.generation = options.generation;
  }
}
