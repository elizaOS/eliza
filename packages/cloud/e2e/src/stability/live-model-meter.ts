/**
 * Meters selected live-model responses at the loopback egress boundary and
 * rejects unaccounted or over-budget provider traffic before it reaches the scenario.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type StabilityModelProvider = "openai" | "anthropic";

export interface StabilityModelBudgets {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequests: number;
}

export type StabilityModelFailureCode =
  | "STABILITY_MODEL_USAGE_MISSING"
  | "STABILITY_MODEL_USAGE_MALFORMED"
  | "STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED"
  | "STABILITY_MODEL_TOKEN_BUDGET_EXHAUSTED"
  | "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED"
  | "STABILITY_MODEL_PROVIDER_ERROR"
  | "STABILITY_MODEL_PROVIDER_TIMEOUT"
  | "STABILITY_MODEL_PROXY_ERROR";

export interface StabilityModelFailure {
  code: StabilityModelFailureCode;
  message: string;
  requestNumber: number;
}

export interface StabilityModelMeterSnapshot {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  failures: StabilityModelFailure[];
}

export interface StabilityModelRequestReservation {
  requestNumber: number;
}

export type StabilityModelRequestAdmission =
  | { allowed: true; reservation: StabilityModelRequestReservation }
  | { allowed: false; failure: StabilityModelFailure };

export class StabilityModelMeterError extends Error {
  constructor(
    readonly code: StabilityModelFailureCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "StabilityModelMeterError";
  }
}

interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseCount(value: unknown, field: string, positive: boolean): number {
  if (
    !Number.isSafeInteger(value) ||
    (positive ? (value as number) <= 0 : (value as number) < 0)
  ) {
    throw new StabilityModelMeterError(
      "STABILITY_MODEL_USAGE_MALFORMED",
      `${field} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
  return value as number;
}

function anthropicInputTokens(usage: Record<string, unknown>): number {
  const inputTokens = parseCount(
    usage.input_tokens,
    "input token usage",
    false,
  );
  const cacheCreation =
    usage.cache_creation_input_tokens === undefined
      ? 0
      : parseCount(
          usage.cache_creation_input_tokens,
          "cache creation input token usage",
          false,
        );
  const cacheRead =
    usage.cache_read_input_tokens === undefined
      ? 0
      : parseCount(
          usage.cache_read_input_tokens,
          "cache read input token usage",
          false,
        );
  const total = inputTokens + cacheCreation + cacheRead;
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new StabilityModelMeterError(
      "STABILITY_MODEL_USAGE_MALFORMED",
      "Anthropic total input token usage must be a positive safe integer",
    );
  }
  return total;
}

function usageFromRecord(
  provider: StabilityModelProvider,
  value: unknown,
): ProviderUsage | null {
  const root = asRecord(value);
  if (!root) return null;
  const response = asRecord(root.response);
  const message = asRecord(root.message);
  const usage =
    asRecord(root.usage) ??
    asRecord(response?.usage) ??
    asRecord(message?.usage);
  if (!usage) return null;
  const input =
    provider === "openai"
      ? (usage.input_tokens ?? usage.prompt_tokens)
      : usage.input_tokens;
  const output =
    provider === "openai"
      ? (usage.output_tokens ?? usage.completion_tokens)
      : usage.output_tokens;
  return {
    inputTokens:
      provider === "anthropic"
        ? anthropicInputTokens(usage)
        : parseCount(input, "input token usage", true),
    outputTokens: parseCount(output, "output token usage", false),
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    // error-policy:J2 Provider bytes are untrusted and the metering boundary must retain the parse cause.
    throw new StabilityModelMeterError(
      "STABILITY_MODEL_USAGE_MALFORMED",
      `provider response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseSseUsage(
  provider: StabilityModelProvider,
  bytes: Buffer,
): ProviderUsage | null {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = parseJson(Buffer.from(data));
    if (provider === "openai") {
      const usage = usageFromRecord(provider, payload);
      if (!usage) continue;
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      continue;
    }
    const root = asRecord(payload);
    const message = asRecord(root?.message);
    const usage = asRecord(root?.usage) ?? asRecord(message?.usage);
    if (!usage) continue;
    if (usage.input_tokens !== undefined) {
      inputTokens = anthropicInputTokens(usage);
    }
    if (usage.output_tokens !== undefined) {
      outputTokens = parseCount(
        usage.output_tokens,
        "output token usage",
        false,
      );
    }
  }
  if (inputTokens === undefined || outputTokens === undefined) return null;
  return { inputTokens, outputTokens };
}

function parseProviderUsage(
  provider: StabilityModelProvider,
  contentType: string,
  bytes: Buffer,
): ProviderUsage {
  const usage = contentType.toLowerCase().includes("text/event-stream")
    ? parseSseUsage(provider, bytes)
    : usageFromRecord(provider, parseJson(bytes));
  if (!usage) {
    throw new StabilityModelMeterError(
      "STABILITY_MODEL_USAGE_MISSING",
      `${provider} successful response omitted authoritative token usage`,
    );
  }
  return usage;
}

function assertBudget(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function providerRouteAllowed(
  provider: StabilityModelProvider,
  method: string | undefined,
  rawTarget: string | undefined,
): boolean {
  if (method !== "POST" || !rawTarget?.startsWith("/")) return false;
  const target = new URL(rawTarget, "http://stability-loopback.invalid");
  if (target.origin !== "http://stability-loopback.invalid" || target.search) {
    return false;
  }
  return provider === "openai"
    ? target.pathname === "/v1/responses" ||
        target.pathname === "/v1/chat/completions"
    : target.pathname === "/v1/messages";
}

/** Aggregates authoritative usage and holds a failed meter closed for the attempt. */
export class LiveModelUsageMeter {
  #requestCount = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  readonly #failures: StabilityModelFailure[] = [];

  constructor(
    readonly provider: StabilityModelProvider,
    readonly budgets: StabilityModelBudgets,
  ) {
    assertBudget(budgets.maxInputTokens, "maxInputTokens");
    assertBudget(budgets.maxOutputTokens, "maxOutputTokens");
    assertBudget(budgets.maxRequests, "maxRequests");
  }

  #failure(
    code: StabilityModelFailureCode,
    message: string,
    requestNumber = this.#requestCount + 1,
  ): StabilityModelMeterError {
    this.#failures.push({
      code,
      message,
      requestNumber,
    });
    return new StabilityModelMeterError(code, message);
  }

  reserveRequest(): StabilityModelRequestAdmission {
    const retained = this.#failures.at(-1);
    if (retained) return { allowed: false, failure: retained };
    if (this.#requestCount >= this.budgets.maxRequests) {
      const error = this.#failure(
        "STABILITY_MODEL_REQUEST_BUDGET_EXCEEDED",
        `model request budget ${this.budgets.maxRequests} is exhausted`,
      );
      return {
        allowed: false,
        failure: this.#failures.at(-1) ?? {
          code: error.code,
          message: error.message,
          requestNumber: this.#requestCount + 1,
        },
      };
    }
    if (
      this.#inputTokens >= this.budgets.maxInputTokens ||
      this.#outputTokens >= this.budgets.maxOutputTokens
    ) {
      const error = this.#failure(
        "STABILITY_MODEL_TOKEN_BUDGET_EXHAUSTED",
        "token budget is exhausted; refusing another provider request",
      );
      return {
        allowed: false,
        failure: this.#failures.at(-1) ?? {
          code: error.code,
          message: error.message,
          requestNumber: this.#requestCount + 1,
        },
      };
    }
    this.#requestCount += 1;
    return {
      allowed: true,
      reservation: { requestNumber: this.#requestCount },
    };
  }

  recordSuccessfulResponse(
    reservation: StabilityModelRequestReservation,
    contentType: string,
    bytes: Buffer,
  ): void {
    let usage: ProviderUsage;
    try {
      usage = parseProviderUsage(this.provider, contentType, bytes);
    } catch (error) {
      // error-policy:J2 Meter failures become retained typed attempt evidence before rethrow.
      const meterError =
        error instanceof StabilityModelMeterError
          ? error
          : new StabilityModelMeterError(
              "STABILITY_MODEL_USAGE_MALFORMED",
              error instanceof Error ? error.message : String(error),
            );
      this.#failures.push({
        code: meterError.code,
        message: meterError.message,
        requestNumber: reservation.requestNumber,
      });
      throw meterError;
    }
    const cumulativeInputTokens = this.#inputTokens + usage.inputTokens;
    const cumulativeOutputTokens = this.#outputTokens + usage.outputTokens;
    if (
      !Number.isSafeInteger(cumulativeInputTokens) ||
      !Number.isSafeInteger(cumulativeOutputTokens)
    ) {
      const error = new StabilityModelMeterError(
        "STABILITY_MODEL_USAGE_MALFORMED",
        "cumulative provider token usage exceeds safe-integer accounting",
      );
      this.#failures.push({
        code: error.code,
        message: error.message,
        requestNumber: reservation.requestNumber,
      });
      throw error;
    }
    this.#inputTokens = cumulativeInputTokens;
    this.#outputTokens = cumulativeOutputTokens;
    if (
      this.#inputTokens > this.budgets.maxInputTokens ||
      this.#outputTokens > this.budgets.maxOutputTokens
    ) {
      const error = new StabilityModelMeterError(
        "STABILITY_MODEL_TOKEN_BUDGET_EXCEEDED",
        `cumulative usage ${this.#inputTokens}/${this.#outputTokens} exceeds ${this.budgets.maxInputTokens}/${this.budgets.maxOutputTokens}`,
      );
      this.#failures.push({
        code: error.code,
        message: error.message,
        requestNumber: reservation.requestNumber,
      });
      throw error;
    }
  }

  recordProviderFailure(
    reservation: StabilityModelRequestReservation,
    code: "STABILITY_MODEL_PROVIDER_ERROR" | "STABILITY_MODEL_PROVIDER_TIMEOUT",
    message: string,
  ): void {
    this.#failures.push({
      code,
      message,
      requestNumber: reservation.requestNumber,
    });
  }

  recordProxyFailure(
    message: string,
    reservation?: StabilityModelRequestReservation,
  ): void {
    this.#failures.push({
      code: "STABILITY_MODEL_PROXY_ERROR",
      message,
      requestNumber: reservation?.requestNumber ?? this.#requestCount + 1,
    });
  }

  snapshot(): StabilityModelMeterSnapshot {
    return {
      requestCount: this.#requestCount,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      failures: structuredClone(this.#failures),
    };
  }
}

export interface StabilityModelProxy {
  url: string;
  snapshot(): StabilityModelMeterSnapshot;
  stop(): Promise<void>;
}

/** Replaces parent-held provider credentials with SDK-only child placeholders. */
export function liveModelScenarioChildEnvironment(
  provider: StabilityModelProvider,
  proxyUrl: string,
  parentEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...parentEnvironment };
  delete environment.OPENAI_API_KEY;
  delete environment.ANTHROPIC_API_KEY;
  if (provider === "openai") {
    environment.OPENAI_BASE_URL = proxyUrl;
    environment.OPENAI_API_KEY = "sk-stability-proxy-placeholder-000000000000";
  } else {
    environment.ANTHROPIC_BASE_URL = proxyUrl;
    environment.ANTHROPIC_API_KEY =
      "sk-ant-stability-proxy-placeholder-000000000000";
  }
  return environment;
}

export async function startLiveModelEgressProxy(options: {
  provider: StabilityModelProvider;
  budgets: StabilityModelBudgets;
  upstreamCredential?: string;
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  upstreamOrigin?: string;
  upstreamTimeoutMs?: number;
  onUpstreamRequest?: (origin: string, method: string) => void;
}): Promise<StabilityModelProxy> {
  const origin =
    options.upstreamOrigin ??
    (options.provider === "openai"
      ? "https://api.openai.com"
      : "https://api.anthropic.com");
  const meter = new LiveModelUsageMeter(options.provider, options.budgets);
  const fetchUpstream = options.fetchUpstream ?? globalThis.fetch;
  const timeoutMs = options.upstreamTimeoutMs ?? 120_000;
  let exchangeTail = Promise.resolve();
  const acquireExchange = async (): Promise<() => void> => {
    const previous = exchangeTail;
    let release = (): void => {};
    exchangeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  const server = createServer((request, response) => {
    let reservation: StabilityModelRequestReservation | undefined;
    let failureRecorded = false;
    void (async () => {
      const chunks: Buffer[] = [];
      let requestBytes = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        requestBytes += bytes.byteLength;
        if (requestBytes > 8 * 1024 * 1024) {
          const message = "provider proxy request exceeded 8 MiB";
          meter.recordProxyFailure(message);
          failureRecorded = true;
          response.writeHead(413, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        chunks.push(bytes);
      }
      const releaseExchange = await acquireExchange();
      try {
        if (
          !providerRouteAllowed(options.provider, request.method, request.url)
        ) {
          meter.recordProxyFailure(
            `provider proxy route rejected: ${request.method ?? "UNKNOWN"} ${request.url ?? "missing"}`,
          );
          failureRecorded = true;
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        const admission = meter.reserveRequest();
        if (!admission.allowed) {
          failureRecorded = true;
          response.writeHead(429, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: admission.failure }));
          return;
        }
        reservation = admission.reservation;
        options.onUpstreamRequest?.(origin, request.method ?? "GET");
        const upstreamHeaders = Object.fromEntries(
          Object.entries(request.headers).flatMap(([key, value]) =>
            value === undefined
              ? []
              : [[key, Array.isArray(value) ? value.join(",") : value]],
          ),
        );
        delete upstreamHeaders.authorization;
        delete upstreamHeaders["x-api-key"];
        delete upstreamHeaders["api-key"];
        delete upstreamHeaders["proxy-authorization"];
        delete upstreamHeaders.host;
        delete upstreamHeaders.connection;
        delete upstreamHeaders["content-length"];
        delete upstreamHeaders["transfer-encoding"];
        delete upstreamHeaders["proxy-connection"];
        if (options.upstreamCredential) {
          if (options.provider === "openai") {
            upstreamHeaders.authorization = `Bearer ${options.upstreamCredential}`;
          } else {
            upstreamHeaders["x-api-key"] = options.upstreamCredential;
          }
        }
        let upstream: Response;
        try {
          upstream = await fetchUpstream(`${origin}${request.url ?? "/"}`, {
            method: request.method,
            headers: upstreamHeaders,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "manual",
          });
        } catch (error) {
          // error-policy:J1 The proxy translates provider timeouts/transport failures into typed attempt evidence.
          const timedOut =
            error instanceof Error && error.name === "TimeoutError";
          meter.recordProviderFailure(
            reservation,
            timedOut
              ? "STABILITY_MODEL_PROVIDER_TIMEOUT"
              : "STABILITY_MODEL_PROVIDER_ERROR",
            error instanceof Error ? error.message : String(error),
          );
          failureRecorded = true;
          response.writeHead(timedOut ? 504 : 502, {
            "content-type": "application/json",
          });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        if (upstream.status >= 300 && upstream.status < 400) {
          const location =
            upstream.headers.get("location") ?? "missing Location";
          meter.recordProxyFailure(
            `provider redirect blocked: ${location}`,
            reservation,
          );
          failureRecorded = true;
          response.writeHead(502, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        let responseBytes: Buffer;
        try {
          responseBytes = Buffer.from(await upstream.arrayBuffer());
        } catch (error) {
          // error-policy:J1 An unreadable upstream response is retained as a counted proxy failure.
          meter.recordProxyFailure(
            error instanceof Error ? error.message : String(error),
            reservation,
          );
          failureRecorded = true;
          response.writeHead(502, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        if (responseBytes.byteLength > 16 * 1024 * 1024) {
          meter.recordProxyFailure(
            "provider proxy response exceeded 16 MiB",
            reservation,
          );
          failureRecorded = true;
          response.writeHead(502, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: meter.snapshot().failures.at(-1) }),
          );
          return;
        }
        if (!upstream.ok) {
          meter.recordProviderFailure(
            reservation,
            "STABILITY_MODEL_PROVIDER_ERROR",
            `provider returned HTTP ${upstream.status}`,
          );
          failureRecorded = true;
        } else {
          try {
            meter.recordSuccessfulResponse(
              reservation,
              upstream.headers.get("content-type") ?? "application/json",
              responseBytes,
            );
          } catch (error) {
            failureRecorded = true;
            // error-policy:J1 Metering failures are returned to the model client and retained in the attempt ledger.
            response.writeHead(502, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                error: {
                  code:
                    error instanceof StabilityModelMeterError
                      ? error.code
                      : "STABILITY_MODEL_USAGE_MALFORMED",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              }),
            );
            return;
          }
        }
        const headers = Object.fromEntries(upstream.headers);
        delete headers["content-encoding"];
        delete headers["content-length"];
        delete headers.connection;
        delete headers["transfer-encoding"];
        response.writeHead(upstream.status, headers);
        response.end(responseBytes);
      } catch (error) {
        // error-policy:J1 A post-admission proxy boundary failure is retained before the serialized exchange is released.
        if (!failureRecorded) {
          meter.recordProxyFailure(
            error instanceof Error ? error.message : "provider proxy failure",
            reservation,
          );
          failureRecorded = true;
        }
        if (!response.headersSent)
          response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "provider proxy failure",
            },
          }),
        );
      } finally {
        releaseExchange();
      }
    })().catch((error: unknown) => {
      // error-policy:J1 The HTTP boundary emits a bounded failure rather than an unhandled rejection.
      if (!failureRecorded) {
        meter.recordProxyFailure(
          error instanceof Error ? error.message : "provider proxy failure",
          reservation,
        );
        failureRecorded = true;
      }
      if (!response.headersSent)
        response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message:
              error instanceof Error ? error.message : "provider proxy failure",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    snapshot: () => meter.snapshot(),
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
