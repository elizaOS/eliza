/**
 * Retrieves short-lived X user credentials from an authenticated Eliza Cloud
 * broker so managed agents never persist the upstream OAuth tokens themselves.
 * The broker owns refresh and rotation: OAuth2 responses carry `expires_at`
 * (epoch seconds) and this provider re-fetches ahead of that deadline, while
 * every cached credential is additionally capped at a short TTL so a
 * broker-side rotation (owner reconnect, refresh-token rotate) propagates
 * without a restart. `invalidate()` drops the cache immediately on rejection.
 * The credential boundary accepts only public HTTPS broker URLs, refuses
 * redirects, bounds and validates the response before copying allowlisted
 * fields, and coalesces concurrent refreshes without reviving invalidated data.
 */
import {
  ElizaError,
  fetchWithSsrfGuard,
  type IAgentRuntime,
  isBlockedHostname,
  isPrivateIpAddress,
  logger,
} from "@elizaos/core";
import { getSetting } from "../../utils/settings";
import type { BrokerAuthCredentials, TwitterBrokerProvider } from "./types";

interface BrokerOAuth2Token {
  auth_mode: "oauth2";
  access_token: string;
  expires_at?: number;
}

interface BrokerOAuth1Token {
  auth_mode: "oauth1";
  consumer_key: string;
  consumer_secret: string;
  access_token: string;
  access_token_secret: string;
}

type BrokerToken = BrokerOAuth1Token | BrokerOAuth2Token;
type BrokerGuardedFetch = typeof fetchWithSsrfGuard;

interface BrokerRequestContext {
  baseUrl: string;
  connectionRole: "agent" | "owner";
  brokerCredential: string;
  identity: string;
}

const BROKER_CACHE_MS = 5 * 60 * 1000;
const OAUTH2_REFRESH_MARGIN_MS = 60 * 1000;
export const BROKER_FETCH_TIMEOUT_MS = 30_000;
export const BROKER_RESPONSE_MAX_BYTES = 16 * 1024;
const BROKER_SECRET_MAX_CHARS = 8 * 1024;
const BROKER_KEY_MAX_CHARS = 1024;

class BrokerResponseError extends ElizaError {}

function brokerError(
  message: string,
  code: string,
  cause?: unknown,
): BrokerResponseError {
  return new BrokerResponseError(message, {
    code,
    severity: "ephemeral",
    ...(cause === undefined ? {} : { cause }),
  });
}

function normalizeBrokerBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // error-policy:J3 Broker configuration is untrusted input and must produce
    // a generic invalid result without reflecting embedded credentials.
    throw brokerError("Invalid X broker URL", "X_BROKER_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    isBlockedHostname(parsed.hostname) ||
    isPrivateIpAddress(parsed.hostname)
  ) {
    throw brokerError("Invalid X broker URL", "X_BROKER_URL_INVALID");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !containsControlCharacter(value)
    ? value
    : null;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function parseBrokerToken(value: unknown): BrokerToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  if (token.auth_mode === "oauth2") {
    const accessToken = boundedString(
      token.access_token,
      BROKER_SECRET_MAX_CHARS,
    );
    const expiresAt = token.expires_at;
    if (!accessToken) return null;
    if (
      expiresAt !== undefined &&
      (!Number.isSafeInteger(expiresAt) ||
        (expiresAt as number) <= 0 ||
        (expiresAt as number) * 1000 <= Date.now() + OAUTH2_REFRESH_MARGIN_MS)
    ) {
      return null;
    }
    return expiresAt === undefined
      ? { auth_mode: "oauth2", access_token: accessToken }
      : {
          auth_mode: "oauth2",
          access_token: accessToken,
          expires_at: expiresAt as number,
        };
  }
  if (token.auth_mode === "oauth1") {
    const consumerKey = boundedString(token.consumer_key, BROKER_KEY_MAX_CHARS);
    const consumerSecret = boundedString(
      token.consumer_secret,
      BROKER_SECRET_MAX_CHARS,
    );
    const accessToken = boundedString(
      token.access_token,
      BROKER_SECRET_MAX_CHARS,
    );
    const accessTokenSecret = boundedString(
      token.access_token_secret,
      BROKER_SECRET_MAX_CHARS,
    );
    if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
      return null;
    }
    return {
      auth_mode: "oauth1",
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
      access_token: accessToken,
      access_token_secret: accessTokenSecret,
    };
  }
  return null;
}

function declaredResponseLength(
  response: Response,
): { kind: "absent" } | { kind: "invalid" } | { kind: "valid"; bytes: number } {
  const header = response.headers.get("content-length");
  if (header === null) return { kind: "absent" };
  if (!/^\d+$/.test(header)) {
    return { kind: "invalid" };
  }
  const length = Number(header);
  return Number.isSafeInteger(length)
    ? { kind: "valid", bytes: length }
    : { kind: "invalid" };
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function observeBrokerCancellation(
  cancel: () => Promise<void>,
  failureMessage: string,
): void {
  try {
    void cancel().catch(() => {
      // error-policy:J6 The authoritative boundary result remains; cancellation
      // is observed but cannot delay guarded transport release.
      logger.debug(failureMessage);
    });
  } catch {
    // error-policy:J6 The authoritative boundary result remains; cancellation
    // is observed but cannot delay guarded transport release.
    logger.debug(failureMessage);
  }
}

function cancelBrokerReaderWithoutWaiting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  observeBrokerCancellation(
    () => reader.cancel(reason),
    "[XBroker] Broker response cancellation failed during teardown",
  );
}

function cancelBrokerBodyWithoutWaiting(
  body: ReadableStream<Uint8Array> | null,
  reason: string,
): void {
  if (!body) return;
  observeBrokerCancellation(
    () => body.cancel(reason),
    "[XBroker] Broker response body cancellation failed during teardown",
  );
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = declaredResponseLength(response);
  if (
    declaredLength.kind === "invalid" ||
    (declaredLength.kind === "valid" &&
      declaredLength.bytes > BROKER_RESPONSE_MAX_BYTES)
  ) {
    cancelBrokerBodyWithoutWaiting(
      response.body,
      "X broker rejected the declared body length",
    );
    throw brokerError(
      declaredLength.kind === "invalid"
        ? "X broker returned an invalid response"
        : "X broker response exceeded the size limit",
      declaredLength.kind === "invalid"
        ? "X_BROKER_RESPONSE_INVALID"
        : "X_BROKER_RESPONSE_TOO_LARGE",
    );
  }
  if (!response.body) {
    throw brokerError(
      "X broker returned an invalid response",
      "X_BROKER_RESPONSE_INVALID",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > BROKER_RESPONSE_MAX_BYTES) {
        cancelBrokerReaderWithoutWaiting(
          reader,
          "X broker response exceeded the size limit",
        );
        throw brokerError(
          "X broker response exceeded the size limit",
          "X_BROKER_RESPONSE_TOO_LARGE",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) {
      cancelBrokerReaderWithoutWaiting(reader, abortReason(signal));
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 The authoritative read result remains while guarded
      // transport release proceeds after best-effort stream lock teardown.
      logger.debug("[XBroker] Broker response reader lock release failed");
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // error-policy:J3 Broker bytes must be valid UTF-8 before JSON parsing.
    throw brokerError(
      "X broker returned an invalid response",
      "X_BROKER_RESPONSE_INVALID",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // error-policy:J3 Malformed broker JSON is an explicit invalid response.
    throw brokerError(
      "X broker returned an invalid response",
      "X_BROKER_RESPONSE_INVALID",
    );
  }
}

export class BrokerAuthProvider implements TwitterBrokerProvider {
  readonly mode = "broker" as const;
  private cached: {
    token: BrokerToken;
    expiresAt: number;
    identity: string;
  } | null = null;
  private inflight: {
    generation: number;
    identity: string;
    controller: AbortController;
    promise: Promise<BrokerToken>;
  } | null = null;
  private cacheGeneration = 0;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly guardedFetch: BrokerGuardedFetch = fetchWithSsrfGuard,
  ) {}

  async getAccessToken(): Promise<string> {
    return (await this.fetchToken()).access_token;
  }

  async getBrokerCredentials(): Promise<BrokerAuthCredentials> {
    const token = await this.fetchToken();
    if (token.auth_mode === "oauth2") {
      return { mode: "oauth2", accessToken: token.access_token };
    }
    return {
      mode: "oauth1",
      appKey: token.consumer_key,
      appSecret: token.consumer_secret,
      accessToken: token.access_token,
      accessSecret: token.access_token_secret,
    };
  }

  invalidate(): void {
    this.cacheGeneration += 1;
    this.cached = null;
    this.inflight?.controller.abort(
      new DOMException("X broker credential was invalidated", "AbortError"),
    );
    this.inflight = null;
  }

  private brokerUrl(): string {
    const explicit = getSetting(this.runtime, "TWITTER_BROKER_URL");
    if (explicit) return normalizeBrokerBaseUrl(explicit);
    const cloudBase =
      getSetting(this.runtime, "ELIZAOS_CLOUD_BASE_URL") ??
      "https://api.eliza.app/api/v1";
    return `${normalizeBrokerBaseUrl(cloudBase)}/twitter`;
  }

  private brokerToken(baseUrl: string): string {
    const explicit = getSetting(this.runtime, "TWITTER_BROKER_TOKEN");
    const origin = new URL(baseUrl).origin.toLowerCase();
    const trustedCloudOrigin = new Set([
      "https://api.eliza.app",
      "https://api-staging.eliza.app",
      "https://cloud.eliza.app",
      "https://cloud-staging.eliza.app",
    ]).has(origin);
    const token =
      explicit ??
      (trustedCloudOrigin
        ? getSetting(this.runtime, "ELIZAOS_CLOUD_API_KEY")
        : undefined);
    if (!token) {
      throw brokerError(
        trustedCloudOrigin
          ? "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_TOKEN or ELIZAOS_CLOUD_API_KEY"
          : "A custom X broker requires an explicit TWITTER_BROKER_TOKEN",
        "X_BROKER_CREDENTIAL_MISSING",
      );
    }
    if (
      token.length > BROKER_SECRET_MAX_CHARS ||
      containsControlCharacter(token)
    ) {
      throw brokerError(
        "Invalid X broker credential",
        "X_BROKER_CREDENTIAL_INVALID",
      );
    }
    return token;
  }

  private connectionRole(): "agent" | "owner" {
    const configured =
      getSetting(this.runtime, "TWITTER_BROKER_CONNECTION_ROLE") ?? "agent";
    const normalized = configured.trim().toLowerCase();
    if (normalized !== "agent" && normalized !== "owner") {
      throw brokerError(
        `Invalid TWITTER_BROKER_CONNECTION_ROLE=${configured}. Expected agent|owner.`,
        "X_BROKER_CONNECTION_ROLE_INVALID",
      );
    }
    return normalized;
  }

  private requestContext(): BrokerRequestContext {
    const baseUrl = this.brokerUrl();
    const connectionRole = this.connectionRole();
    const brokerCredential = this.brokerToken(baseUrl);
    return {
      baseUrl,
      connectionRole,
      brokerCredential,
      identity: `${baseUrl}\u0000${connectionRole}\u0000${brokerCredential}`,
    };
  }

  private async fetchToken(): Promise<BrokerToken> {
    const context = this.requestContext();
    if (
      this.cached &&
      this.cached.identity === context.identity &&
      Date.now() < this.cached.expiresAt
    ) {
      return this.cached.token;
    }
    if (this.cached && this.cached.identity !== context.identity)
      this.invalidate();
    if (
      this.inflight &&
      (this.inflight.generation !== this.cacheGeneration ||
        this.inflight.identity !== context.identity)
    ) {
      this.invalidate();
    }
    if (
      this.inflight?.generation === this.cacheGeneration &&
      this.inflight.identity === context.identity
    ) {
      return this.inflight.promise;
    }

    const generation = this.cacheGeneration;
    const controller = new AbortController();
    const promise = this.fetchFromBroker(context, controller.signal).then(
      (token) => {
        const cacheCap = Date.now() + BROKER_CACHE_MS;
        const expiresAt =
          token.auth_mode === "oauth2" && token.expires_at
            ? Math.min(
                token.expires_at * 1000 - OAUTH2_REFRESH_MARGIN_MS,
                cacheCap,
              )
            : cacheCap;
        if (generation === this.cacheGeneration) {
          this.cached = { token, expiresAt, identity: context.identity };
        }
        return token;
      },
    );
    const inflight = {
      generation,
      identity: context.identity,
      controller,
      promise,
    };
    this.inflight = inflight;

    try {
      return await promise;
    } finally {
      if (this.inflight === inflight) this.inflight = null;
    }
  }

  private async fetchFromBroker(
    context: BrokerRequestContext,
    invalidationSignal: AbortSignal,
  ): Promise<BrokerToken> {
    const url = `${context.baseUrl}/token?connectionRole=${context.connectionRole}`;
    const authorization = `Bearer ${context.brokerCredential}`;
    const timeoutSignal = AbortSignal.timeout(BROKER_FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([timeoutSignal, invalidationSignal]);
    let release: (() => Promise<void>) | undefined;
    try {
      const guarded = await this.guardedFetch({
        url,
        maxRedirects: 0,
        signal,
        init: {
          headers: {
            Accept: "application/json",
            Authorization: authorization,
          },
        },
      });
      release = guarded.release;
      const response = guarded.response;
      if (response.status === 401 || response.status === 403) {
        this.cacheGeneration += 1;
        this.cached = null;
        cancelBrokerBodyWithoutWaiting(
          response.body,
          "X broker rejected the credential",
        );
        throw brokerError(
          `X broker rejected the agent credential (${response.status})`,
          "X_BROKER_CREDENTIAL_REJECTED",
        );
      }
      if (!response.ok) {
        cancelBrokerBodyWithoutWaiting(
          response.body,
          "X broker returned a non-success status",
        );
        throw brokerError(
          `X broker request failed (${response.status})`,
          "X_BROKER_HTTP_FAILED",
        );
      }
      const value = await readBoundedJson(response, signal);
      const token = parseBrokerToken(value);
      if (!token) {
        throw brokerError(
          "X broker returned an invalid credential response",
          "X_BROKER_RESPONSE_INVALID",
        );
      }
      return token;
    } catch (error) {
      // error-policy:J1 This credential boundary preserves its own deadline
      // while translating transport/parser failures without echoing secrets.
      if (signal.aborted) throw abortReason(signal);
      if (error instanceof BrokerResponseError) throw error;
      throw brokerError(
        "X broker request failed",
        "X_BROKER_TRANSPORT_FAILED",
        new Error("Broker transport or stream failed"),
      );
    } finally {
      await release?.();
    }
  }
}
