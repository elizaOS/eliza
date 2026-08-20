/**
 * Shared bounded, SSRF-guarded JSON-over-HTTP transport core for design
 * provider adapters. Credentials are pinned to one configured origin;
 * redirects are rejected and every production connection uses core's
 * DNS-pinned transport. Provider-specific wire semantics stay in the
 * adapters, which supply the error classifier for non-2xx statuses.
 */

import {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  isBlockedHostname,
  isPrivateIpAddress,
  logger,
  SsrfBlockedError,
} from "@elizaos/core";
import { DesignError } from "./errors.js";

export type DesignTestTransport = Pick<
  GuardedFetchOptions,
  "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
>;

export interface DesignHttpCoreOptions {
  providerId: string;
  connectionId: string;
  baseUrl: string;
  /** Header name plus formatted value; the raw credential never appears elsewhere. */
  credentialHeader?: { name: string; value: string };
  timeoutMs?: number;
  responseByteLimit?: number;
  /** Explicit transport seam for deterministic SSRF/adversarial tests only. */
  testTransport?: DesignTestTransport;
  /** Allows an injected test transport to reach its loopback fake upstream. */
  allowPrivateNetworkForTests?: boolean;
  /** Maps a non-2xx provider response to a typed domain failure. */
  classifyError: (
    status: number,
    body: unknown,
    retryAfterMs: number | undefined,
  ) => DesignError;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface RequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

function requestDeadline(timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Design deadline elapsed", "TimeoutError"),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

function observeTeardown(operation: Promise<unknown>, surface: string): void {
  // error-policy:J6 Teardown is intentionally non-blocking; a redacted debug
  // observation keeps cancellation failures visible without delaying results.
  void operation.catch((error) => {
    logger.debug(
      {
        errorName: error instanceof Error ? error.name : typeof error,
        surface,
      },
      "[DesignHttpCore] Response-stream teardown did not complete cleanly",
    );
  });
}

function cancelBody(response: Response, reason: string): void {
  // error-policy:J6 Cancellation is teardown only and must never delay the
  // typed terminal result from an untrusted response stream.
  if (response.body) observeTeardown(response.body.cancel(reason), reason);
}

export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export interface JsonSchemaLike<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

export class DesignHttpCore {
  readonly providerId: string;
  readonly connectionId: string;
  readonly baseOrigin: string;
  private readonly credentialHeader?: { name: string; value: string };
  private readonly timeoutMs: number;
  private readonly responseByteLimit: number;
  private readonly testTransport?: DesignTestTransport;
  private readonly allowPrivateNetworkForTests: boolean;
  private readonly classifyError: DesignHttpCoreOptions["classifyError"];

  constructor(options: DesignHttpCoreOptions) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(options.providerId)) {
      throw new DesignError("Design adapter id is invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    if (!/^conn_[A-Za-z0-9_-]{16,}$/.test(options.connectionId)) {
      throw new DesignError("Design adapter connection id must be opaque.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch (error) {
      throw new DesignError("Design adapter endpoint is invalid.", {
        code: "DESIGN_INVALID_INPUT",
        cause: error,
      });
    }
    const allowPrivateTest = options.allowPrivateNetworkForTests === true;
    if (allowPrivateTest && !options.testTransport?.fetchImpl) {
      throw new DesignError(
        "Private-network design endpoints require an explicit injected test transport.",
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    if (
      baseUrl.protocol !== "https:" &&
      !(allowPrivateTest && baseUrl.protocol === "http:")
    ) {
      throw new DesignError("Design adapter endpoint must use HTTPS.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new DesignError(
        "Design adapter endpoint cannot contain userinfo, query, or fragment data.",
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    if (baseUrl.pathname !== "/") {
      throw new DesignError("Design adapter endpoint must be an origin URL.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    if (
      !allowPrivateTest &&
      (isBlockedHostname(baseUrl.hostname) ||
        isPrivateIpAddress(baseUrl.hostname))
    ) {
      throw new DesignError("Design adapter endpoint is not a public origin.", {
        code: "DESIGN_ENDPOINT_BLOCKED",
      });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isFinite(timeoutMs) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new DesignError(
        `Design adapter timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`,
        { code: "DESIGN_INVALID_INPUT" },
      );
    }
    const responseByteLimit =
      options.responseByteLimit ?? DEFAULT_RESPONSE_BYTES;
    if (
      !Number.isFinite(responseByteLimit) ||
      !Number.isInteger(responseByteLimit) ||
      responseByteLimit < 1 ||
      responseByteLimit > MAX_RESPONSE_BYTES
    ) {
      throw new DesignError("Design adapter response byte limit is invalid.", {
        code: "DESIGN_INVALID_INPUT",
      });
    }
    this.providerId = options.providerId;
    this.connectionId = options.connectionId;
    this.baseOrigin = baseUrl.origin;
    this.credentialHeader = options.credentialHeader;
    this.timeoutMs = timeoutMs;
    this.responseByteLimit = responseByteLimit;
    this.testTransport = options.testTransport;
    this.allowPrivateNetworkForTests = allowPrivateTest;
    this.classifyError = options.classifyError;
  }

  /** Requests and strictly decodes one JSON resource; 404 resolves null when allowed. */
  async requestJson<T>(
    url: URL,
    init: RequestInit,
    schema: JsonSchemaLike<T>,
    options?: { allowNotFound?: boolean },
  ): Promise<T | null> {
    const deadline = requestDeadline(this.timeoutMs);
    try {
      const guarded = await this.fetchResponse(url, init, deadline);
      try {
        if (options?.allowNotFound && guarded.response.status === 404) {
          cancelBody(guarded.response, "design resource was not found");
          return null;
        }
        return await this.decodeResponse(guarded.response, schema, deadline);
      } finally {
        await guarded.release();
      }
    } finally {
      deadline.dispose();
    }
  }

  private async fetchResponse(
    url: URL,
    init: RequestInit,
    deadline: RequestDeadline,
  ): ReturnType<typeof fetchWithSsrfGuard> {
    if (url.origin !== this.baseOrigin) {
      throw new DesignError(
        "Design request escaped the configured provider origin.",
        { code: "DESIGN_ENDPOINT_BLOCKED" },
      );
    }
    const headers = new Headers(init.headers);
    if (this.credentialHeader)
      headers.set(this.credentialHeader.name, this.credentialHeader.value);
    headers.set("x-design-connection-id", this.connectionId);
    try {
      return await fetchWithSsrfGuard({
        url: url.href,
        init: { ...init, headers, redirect: "manual", signal: deadline.signal },
        maxRedirects: 0,
        timeoutMs: this.timeoutMs,
        signal: deadline.signal,
        policy: this.allowPrivateNetworkForTests
          ? { allowPrivateNetwork: true }
          : undefined,
        ...this.testTransport,
      });
    } catch (error) {
      // error-policy:J2 Add a typed provider/network classification while
      // preserving the original transport failure as the cause.
      if (
        deadline.signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        throw new DesignError("The design provider timed out.", {
          code: "DESIGN_PROVIDER_TIMEOUT",
          cause: error,
        });
      }
      if (error instanceof SsrfBlockedError) {
        throw new DesignError(
          "The design provider endpoint was blocked by network policy.",
          { code: "DESIGN_ENDPOINT_BLOCKED", cause: error },
        );
      }
      throw new DesignError("The design provider connection failed.", {
        code: "DESIGN_PROVIDER_NETWORK",
        cause: error,
      });
    }
  }

  private async readBoundedBody(
    response: Response,
    deadline: RequestDeadline,
  ): Promise<string> {
    const declared = response.headers.get("content-length");
    if (
      declared &&
      /^\d+$/.test(declared) &&
      Number(declared) > this.responseByteLimit
    ) {
      cancelBody(response, "design declared response exceeded byte limit");
      throw new DesignError(
        "The design provider response exceeded the byte limit.",
        {
          code: "DESIGN_RESPONSE_TOO_LARGE",
          context: { status: response.status, limit: this.responseByteLimit },
        },
      );
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            const onAbort = () =>
              reject(
                deadline.signal.reason ??
                  new DOMException("Design deadline elapsed", "TimeoutError"),
              );
            if (deadline.signal.aborted) return onAbort();
            deadline.signal.addEventListener("abort", onAbort, { once: true });
            void reader
              .read()
              .then(resolve, reject)
              .finally(() =>
                deadline.signal.removeEventListener("abort", onAbort),
              );
          },
        );
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.responseByteLimit) {
          observeTeardown(
            reader.cancel("design response exceeded byte limit"),
            "response-too-large",
          );
          throw new DesignError(
            "The design provider response exceeded the byte limit.",
            {
              code: "DESIGN_RESPONSE_TOO_LARGE",
              context: {
                status: response.status,
                limit: this.responseByteLimit,
              },
            },
          );
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } catch (error) {
      if (error instanceof DesignError) throw error;
      if (
        deadline.signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        observeTeardown(
          reader.cancel("design response deadline elapsed"),
          "response-deadline",
        );
        throw new DesignError("The design provider timed out.", {
          code: "DESIGN_PROVIDER_TIMEOUT",
          cause: error,
          context: { status: response.status },
        });
      }
      // error-policy:J2 Provider bytes are untrusted; preserve bounded read and
      // UTF-8 failures without retaining or exposing response content.
      throw new DesignError(
        "The design provider response body could not be read.",
        {
          code: "DESIGN_MALFORMED_RESPONSE",
          cause: error,
          context: { status: response.status },
        },
      );
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        // error-policy:J6 A pending untrusted read owns the lock until its
        // non-blocking cancellation settles; terminal classification is fixed.
        logger.debug(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            surface: "reader-release-lock",
          },
          "[DesignHttpCore] Response reader lock remained pending during teardown",
        );
      }
    }
  }

  private async decodeResponse<T>(
    response: Response,
    schema: JsonSchemaLike<T>,
    deadline: RequestDeadline,
  ): Promise<T> {
    if (!response.ok) {
      let errorBody: unknown;
      if (response.status < 500) {
        try {
          const text = await this.readBoundedBody(response, deadline);
          if (text) errorBody = JSON.parse(text);
        } catch {
          // error-policy:J3 Diagnostic bytes are optional; once headers carry
          // an error status, timeout/size/parse failures cannot replace it.
          errorBody = undefined;
        }
      } else {
        cancelBody(response, "design provider returned an error status");
      }
      throw this.classifyError(
        response.status,
        errorBody,
        retryAfterMs(response),
      );
    }
    const text = await this.readBoundedBody(response, deadline);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      // error-policy:J2 Provider bytes are untrusted; preserve the JSON parse
      // failure without retaining or exposing the response body.
      throw new DesignError("The design provider returned malformed JSON.", {
        code: "DESIGN_MALFORMED_RESPONSE",
        cause: error,
        context: { status: response.status },
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DesignError(
        "The design provider response did not match the contract.",
        {
          code: "DESIGN_MALFORMED_RESPONSE",
          cause: parsed.error,
          context: { status: response.status },
        },
      );
    }
    return parsed.data;
  }
}
