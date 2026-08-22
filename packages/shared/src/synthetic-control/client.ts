/** Sends authenticated synthetic-control commands and rejects malformed or mismatched subprocess replies. */

import { randomUUID } from "node:crypto";
import {
  parseSyntheticControlRequest,
  parseSyntheticControlResponse,
  readBoundedJson,
} from "./codec.js";
import {
  type JsonValue,
  SYNTHETIC_CONTROL_MAX_REQUEST_BYTES,
  SYNTHETIC_CONTROL_MAX_RESPONSE_BYTES,
  SYNTHETIC_CONTROL_PATH,
  type SyntheticControlCommand,
  SyntheticControlProtocolError,
  type SyntheticControlRequest,
} from "./types.js";

export interface SyntheticControlClientOptions {
  baseUrl: string;
  namespace: string;
  token: string;
  timeoutMs?: number;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface SyntheticControlCommandOptions {
  commandId?: string;
  expectedGeneration?: number;
  leaseId?: string;
  signal?: AbortSignal;
}

export class SyntheticControlClient {
  readonly endpoint: URL;
  readonly namespace: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;

  constructor(options: SyntheticControlClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new Error("synthetic control baseUrl must use http or https");
    }
    if (
      base.protocol === "http:" &&
      base.hostname !== "localhost" &&
      base.hostname !== "[::1]" &&
      !base.hostname.startsWith("127.")
    ) {
      throw new Error(
        "synthetic control http baseUrl must resolve to a loopback host",
      );
    }
    if (base.username || base.password) {
      throw new Error("synthetic control baseUrl must not contain credentials");
    }
    const namespace = options.namespace.trim();
    if (namespace.length === 0 || namespace.length > 512) {
      throw new Error(
        "synthetic control namespace must contain at most 512 characters",
      );
    }
    if (options.token.trim().length < 16) {
      throw new Error(
        "synthetic control token must contain at least 16 characters",
      );
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 300_000
    ) {
      throw new Error(
        "synthetic control timeoutMs must be an integer between 1 and 300000",
      );
    }
    this.endpoint = new URL(SYNTHETIC_CONTROL_PATH, base);
    this.namespace = namespace;
    this.token = options.token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async command(
    command: SyntheticControlCommand,
    options: SyntheticControlCommandOptions = {},
  ): Promise<{ generation: number; data: JsonValue }> {
    const commandId = options.commandId ?? randomUUID();
    const request: SyntheticControlRequest = {
      version: 1,
      namespace: this.namespace,
      commandId,
      command,
      ...(options.expectedGeneration === undefined
        ? {}
        : { expectedGeneration: options.expectedGeneration }),
      ...(options.leaseId === undefined ? {} : { leaseId: options.leaseId }),
    };
    // Validate before JSON serialization so functions, undefined, cycles, and
    // non-finite numbers cannot be silently erased or rewritten on the wire.
    parseSyntheticControlRequest(request);
    const body = JSON.stringify(request);
    if (
      new TextEncoder().encode(body).byteLength >
      SYNTHETIC_CONTROL_MAX_REQUEST_BYTES
    ) {
      throw new Error(
        `synthetic control request exceeds ${SYNTHETIC_CONTROL_MAX_REQUEST_BYTES} bytes`,
      );
    }
    if (options.signal?.aborted) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: "synthetic control command was aborted before dispatch",
        retryable: true,
        generation: options.expectedGeneration,
      });
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body,
        signal,
      });
    } catch (error) {
      // error-policy:J1 The client transport boundary exposes a typed failure without claiming execution state.
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: "synthetic control transport failed",
        retryable: true,
        cause: error,
      });
    }
    let parsed: ReturnType<typeof parseSyntheticControlResponse>;
    try {
      parsed = parseSyntheticControlResponse(
        await readBoundedJson(
          response,
          SYNTHETIC_CONTROL_MAX_RESPONSE_BYTES,
          "synthetic control response",
        ),
      );
    } catch (error) {
      // error-policy:J1 Malformed wire replies become a typed protocol failure at the client boundary.
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: `synthetic control returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (parsed.commandId !== commandId) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message:
          "synthetic control response commandId did not match the request",
      });
    }
    if (parsed.namespace !== this.namespace) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message:
          "synthetic control response namespace did not match the request",
      });
    }
    if (!parsed.ok) {
      throw new SyntheticControlProtocolError({
        ...parsed.error,
        generation: parsed.generation ?? undefined,
      });
    }
    if (!response.ok) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: `synthetic control returned HTTP ${response.status} with a success envelope`,
      });
    }
    return { generation: parsed.generation, data: parsed.data };
  }
}
