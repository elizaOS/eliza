/** Sends authenticated synthetic-control commands and rejects malformed or mismatched subprocess replies. */

import { randomUUID } from "node:crypto";
import {
  parseSyntheticControlRequest,
  parseSyntheticControlResponse,
} from "./codec.js";
import {
  type JsonValue,
  SYNTHETIC_CONTROL_PATH,
  type SyntheticControlCommand,
  SyntheticControlProtocolError,
  type SyntheticControlRequest,
} from "./types.js";

export interface SyntheticControlClientOptions {
  baseUrl: string;
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
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: `synthetic control transport failed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      });
    }
    let parsed: ReturnType<typeof parseSyntheticControlResponse>;
    try {
      parsed = parseSyntheticControlResponse(await response.json());
    } catch (error) {
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
        generation: parsed.generation,
      });
    }
    if (!parsed.ok) {
      throw new SyntheticControlProtocolError({
        ...parsed.error,
        generation: parsed.generation,
      });
    }
    if (!response.ok) {
      throw new SyntheticControlProtocolError({
        code: "COMMAND_FAILED",
        message: `synthetic control returned HTTP ${response.status} with a success envelope`,
        generation: parsed.generation,
      });
    }
    return { generation: parsed.generation, data: parsed.data };
  }
}
