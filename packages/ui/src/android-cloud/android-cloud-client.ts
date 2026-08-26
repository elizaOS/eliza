/**
 * Cloud protocol client used by the native Android authentication handoff.
 *
 * This module deliberately has no dependency on ElizaClient, AppContext, the
 * desktop/native-agent transports, or any plugin registry. Every request is
 * pinned to the canonical Eliza Cloud API or to an HTTPS runtime authority
 * returned by that API.
 */

import { logger } from "@elizaos/logger";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  directCloudAppBaseForApi,
  resolveCanonicalDirectCloudApiBase,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
} from "../api/direct-cloud-endpoints";

const MANAGED_RUNTIME_HOST_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cloud(?:-staging)?\.eliza\.app$/i;
const MOBILE_APP_AUTH_CLIENT_ID = "ai.elizaos.app";
const MOBILE_APP_AUTH_REDIRECT_URI = "https://eliza.app/auth/callback";
const MOBILE_AUTH_CONFIG_TIMEOUT_MS = 15_000;
export const ANDROID_CLOUD_PENDING_LOGIN_KEY =
  "eliza:android-cloud:pending-login:v1";

export interface AndroidCloudIdentity {
  id: string;
  displayName: string;
}

export interface AndroidCloudSession {
  identity: AndroidCloudIdentity;
  token: string;
  chatApiBase: string;
}

export interface AndroidCloudTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface AndroidCloudLoginAttempt {
  state: string;
  browserUrl: string;
}

export interface AndroidCloudLoginCompletion {
  apiBase: string;
  pendingCleanupRequired: boolean;
  state: string;
}

export type AndroidCloudCallbackDisposition = "acknowledge" | "retry";

/** Carries the native replay decision without exposing protocol internals. */
export class AndroidCloudAuthError extends Error {
  readonly attemptId: string | null;
  readonly disposition: AndroidCloudCallbackDisposition;

  constructor(
    message: string,
    options: {
      attemptId?: string | null;
      cause?: unknown;
      disposition: AndroidCloudCallbackDisposition;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AndroidCloudAuthError";
    this.attemptId = options.attemptId ?? null;
    this.disposition = options.disposition;
  }
}

export function shouldAcknowledgeAndroidCloudCallback(error: unknown): boolean {
  return (
    error instanceof AndroidCloudAuthError &&
    error.disposition === "acknowledge"
  );
}

interface AndroidCloudPendingLogin {
  clientId: typeof MOBILE_APP_AUTH_CLIENT_ID;
  codeVerifier: string;
  environment: "staging" | "production";
  redirectUri: typeof MOBILE_APP_AUTH_REDIRECT_URI;
  state: string;
}

export interface AndroidCloudClientOptions {
  cloudApiBase?: string;
  fetchImpl?: typeof fetch;
  credentialStore?: AndroidCloudCredentialStore;
  pendingLoginStore?: AndroidCloudPendingLoginStore;
}

export interface AndroidCloudCredentialStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface AndroidCloudPendingLoginStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

const browserCredentialStore: AndroidCloudCredentialStore = {
  async read() {
    return readStoredStewardToken()?.trim() || null;
  },
  async write(token) {
    await writeStoredStewardToken(token);
  },
  async clear() {
    await clearStoredStewardToken();
  },
};

const browserPendingLoginStore: AndroidCloudPendingLoginStore = {
  async read() {
    return window.localStorage.getItem(ANDROID_CLOUD_PENDING_LOGIN_KEY);
  },
  async write(value) {
    window.localStorage.setItem(ANDROID_CLOUD_PENDING_LOGIN_KEY, value);
  },
  async clear() {
    window.localStorage.removeItem(ANDROID_CLOUD_PENDING_LOGIN_KEY);
  },
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePendingLogin(value: string): AndroidCloudPendingLogin | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // error-policy:J3 malformed protected pending-login JSON is an explicit
    // invalid signal; callers never treat it as a valid authentication state.
    return null;
  }
  const pending = record(parsed);
  const clientId = stringField(pending?.clientId);
  const codeVerifier = stringField(pending?.codeVerifier);
  const environment = stringField(pending?.environment);
  const redirectUri = stringField(pending?.redirectUri);
  const state = stringField(pending?.state);
  if (
    clientId !== MOBILE_APP_AUTH_CLIENT_ID ||
    !codeVerifier ||
    (environment !== "staging" && environment !== "production") ||
    redirectUri !== MOBILE_APP_AUTH_REDIRECT_URI ||
    !state
  ) {
    return null;
  }
  return { clientId, codeVerifier, environment, redirectUri, state };
}

function apiBaseForEnvironment(
  environment: AndroidCloudPendingLogin["environment"],
): string {
  return environment === "staging"
    ? STAGING_DIRECT_CLOUD_API_BASE_URL
    : DEFAULT_DIRECT_CLOUD_API_BASE_URL;
}

function singleCallbackValue(
  callback: URL,
  key: "code" | "error" | "error_description" | "state",
): string | null {
  const values = callback.searchParams.getAll(key);
  if (values.length > 1) {
    throw new AndroidCloudAuthError(
      "Eliza Cloud returned an ambiguous app callback.",
      { disposition: "acknowledge" },
    );
  }
  return values[0]?.trim() || null;
}

function parseCanonicalCallback(callbackUrl: string): {
  callback: URL;
  returnedState: string | null;
} {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch (error) {
    throw new AndroidCloudAuthError(
      "Eliza Cloud returned an invalid app callback.",
      { cause: error, disposition: "acknowledge" },
    );
  }
  const allowedKeys = new Set(["code", "error", "error_description", "state"]);
  const hasUnknownKey = [...callback.searchParams.keys()].some(
    (key) => !allowedKeys.has(key),
  );
  if (
    callback.protocol !== "elizaos:" ||
    callback.hostname !== "auth" ||
    callback.pathname !== "/callback" ||
    callback.username ||
    callback.password ||
    callback.port ||
    callback.hash ||
    hasUnknownKey
  ) {
    throw new AndroidCloudAuthError(
      "Eliza Cloud returned an untrusted app callback.",
      { disposition: "acknowledge" },
    );
  }
  const returnedState = singleCallbackValue(callback, "state");
  return { callback, returnedState };
}

/** Validates the complete native callback grammar before exposing its attempt. */
export function parseAndroidCloudCallbackAttemptId(
  callbackUrl: string,
): string | null {
  return parseCanonicalCallback(callbackUrl).returnedState;
}

function protocolFailure(
  message: string,
  responseStatus: number,
  attemptId: string,
): AndroidCloudAuthError {
  const retryableStatus =
    responseStatus === 408 ||
    responseStatus === 425 ||
    responseStatus === 429 ||
    responseStatus >= 500;
  return new AndroidCloudAuthError(message, {
    attemptId,
    disposition: retryableStatus ? "retry" : "acknowledge",
  });
}

async function responseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  // An empty body is legitimate (204, and some error responses); a body that
  // is present but unparsable is a broken endpoint. Collapsing both to {} made
  // an unreadable 200 must never look like a valid empty protocol response.
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // error-policy:J3 untrusted response body — an explicit failure, never a
    // fabricated empty record that reads as a valid-but-pending answer.
    throw new Error("Eliza Cloud returned a response that could not be read.", {
      cause: error,
    });
  }
  const body = record(parsed);
  if (!body) {
    throw new Error("Eliza Cloud returned an invalid JSON response.");
  }
  return body;
}

function responseError(body: JsonRecord, fallback: string): string {
  return stringField(body.error) ?? stringField(body.message) ?? fallback;
}

function mobileAuthResponseError(body: JsonRecord, fallback: string): string {
  const code = stringField(body.error);
  if (code === "server_configuration_error") {
    return "Eliza Cloud sign-in is not configured for this app yet.";
  }
  if (code === "temporarily_unavailable") {
    return "Eliza Cloud sign-in is temporarily unavailable. Please try again.";
  }
  return (
    stringField(body.message) ??
    stringField(body.errorDescription) ??
    code ??
    fallback
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomBinding(byteLength = 48): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

/** Accept only the official control plane or an Eliza-managed runtime host. */
export function resolveAndroidCloudChatAuthority(
  value: unknown,
  expectedIdentityId?: string,
): string {
  const candidate = stringField(value);
  if (!candidate) throw new Error("Eliza Cloud returned no chat authority.");
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    const expectedSharedPath = expectedIdentityId
      ? `/api/v1/eliza/agents/${encodeURIComponent(expectedIdentityId)}`
      : null;
    const hasCleanAuthority =
      !url.username && !url.password && !url.port && !url.search && !url.hash;
    const isOfficialSharedAdapter =
      hasCleanAuthority &&
      resolveCanonicalDirectCloudApiBase(candidate) === url.origin &&
      expectedSharedPath !== null &&
      url.pathname.replace(/\/+$/, "") === expectedSharedPath;
    const isManagedRuntime =
      hasCleanAuthority &&
      MANAGED_RUNTIME_HOST_PATTERN.test(hostname) &&
      (url.pathname === "" || url.pathname === "/");
    if (
      url.protocol !== "https:" ||
      (!isOfficialSharedAdapter && !isManagedRuntime)
    ) {
      throw new Error("Eliza Cloud returned an untrusted chat authority.");
    }
    return isOfficialSharedAdapter
      ? `${url.origin}${expectedSharedPath}`
      : url.origin;
  } catch (error) {
    // error-policy:J3 untrusted Cloud authority input becomes an explicit
    // invalid result instead of escaping URL parser details to the caller.
    if (error instanceof Error && error.message.includes("untrusted")) {
      throw error;
    }
    throw new Error("Eliza Cloud returned an invalid chat authority.");
  }
}

export class AndroidCloudClient {
  readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentialStore: AndroidCloudCredentialStore;
  private readonly pendingLoginStore: AndroidCloudPendingLoginStore;
  private pendingLogin: AndroidCloudPendingLogin | null = null;

  constructor(options: AndroidCloudClientOptions = {}) {
    this.apiBase = resolveCanonicalDirectCloudApiBase(options.cloudApiBase);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentialStore = options.credentialStore ?? browserCredentialStore;
    this.pendingLoginStore =
      options.pendingLoginStore ?? browserPendingLoginStore;
  }

  async readToken(): Promise<string | null> {
    return (await this.credentialStore.read())?.trim() || null;
  }

  async restoreSession(): Promise<AndroidCloudSession | null> {
    const token = await this.readToken();
    if (!token) return null;
    const response = await this.fetchImpl(
      `${this.apiBase}/api/v1/eliza/personal`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (response.status === 401) {
      await this.credentialStore.clear();
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `Unable to verify your Eliza session (${response.status}).`,
      );
    }
    const body = await responseJson(response);
    const identityBody =
      record(record(body.data)?.identity) ?? record(body.identity);
    const id = stringField(identityBody?.id);
    if (!id)
      throw new Error("Eliza Cloud returned an invalid account session.");
    const displayName =
      stringField(identityBody?.displayName) ??
      stringField(identityBody?.name) ??
      "Eliza user";
    const runtime = stringField(identityBody?.runtime)?.toLowerCase();
    const declaredApiBase = stringField(identityBody?.apiBase);
    const chatApiBase =
      runtime === "shared"
        ? resolveAndroidCloudChatAuthority(
            `${this.apiBase}/api/v1/eliza/agents/${encodeURIComponent(id)}`,
            id,
          )
        : runtime === "dedicated" && declaredApiBase
          ? resolveAndroidCloudChatAuthority(declaredApiBase, id)
          : (() => {
              throw new Error(
                "Eliza Cloud returned an invalid runtime binding.",
              );
            })();
    return { identity: { id, displayName }, token, chatApiBase };
  }

  async beginLogin(): Promise<AndroidCloudLoginAttempt> {
    const clientId = MOBILE_APP_AUTH_CLIENT_ID;
    const redirectUri = MOBILE_APP_AUTH_REDIRECT_URI;
    const environment =
      this.apiBase === STAGING_DIRECT_CLOUD_API_BASE_URL
        ? "staging"
        : "production";
    const state = randomBinding();
    const codeVerifier = randomBinding(64);
    const codeChallenge = await s256Challenge(codeVerifier);
    const binding = { clientId, environment, redirectUri };
    const configUrl = new URL(`${this.apiBase}/api/v1/app-auth/mobile/config`);
    for (const [key, value] of Object.entries(binding))
      configUrl.searchParams.set(key, value);
    const configResponse = await this.fetchImpl(configUrl, {
      signal: AbortSignal.timeout(MOBILE_AUTH_CONFIG_TIMEOUT_MS),
    });
    const configBody = await responseJson(configResponse);
    if (!configResponse.ok) {
      throw new Error(
        mobileAuthResponseError(
          configBody,
          "Eliza Cloud sign-in is unavailable.",
        ),
      );
    }
    if (
      configBody.success !== true ||
      stringField(configBody.clientId) !== clientId ||
      stringField(configBody.environment) !== environment ||
      stringField(configBody.redirectUri) !== redirectUri ||
      stringField(configBody.codeChallengeMethod) !== "S256"
    ) {
      throw new Error("Eliza Cloud returned invalid mobile sign-in metadata.");
    }

    const pendingLogin: AndroidCloudPendingLogin = {
      clientId,
      codeVerifier,
      environment,
      redirectUri,
      state,
    };
    await this.pendingLoginStore.write(JSON.stringify(pendingLogin));
    this.pendingLogin = pendingLogin;

    const authorizePath = new URL(
      "/app-auth/authorize",
      directCloudAppBaseForApi(this.apiBase),
    );
    authorizePath.searchParams.set("flow", "mobile_pkce");
    authorizePath.searchParams.set("client_id", clientId);
    authorizePath.searchParams.set("environment", environment);
    authorizePath.searchParams.set("redirect_uri", redirectUri);
    authorizePath.searchParams.set("state", state);
    authorizePath.searchParams.set("code_challenge", codeChallenge);
    authorizePath.searchParams.set("code_challenge_method", "S256");
    authorizePath.searchParams.set("device_name", "Android");

    const loginUrl = new URL("/login", directCloudAppBaseForApi(this.apiBase));
    loginUrl.searchParams.set(
      "returnTo",
      `${authorizePath.pathname}${authorizePath.search}`,
    );
    return { state, browserUrl: loginUrl.toString() };
  }

  async cancelLogin(expectedState?: string): Promise<boolean> {
    if (expectedState) {
      const storedPending = await this.pendingLoginStore.read();
      const persisted = storedPending ? parsePendingLogin(storedPending) : null;
      const currentState = persisted?.state ?? this.pendingLogin?.state ?? null;
      if (currentState !== expectedState) return false;
    }
    this.pendingLogin = null;
    await this.pendingLoginStore.clear();
    return true;
  }

  private async clearTerminalLogin(expectedState: string): Promise<void> {
    try {
      await this.cancelLogin(expectedState);
    } catch (err) {
      // error-policy:J6 terminal PKCE cleanup is best-effort after the protocol
      // has already decided the callback; the typed disposition must remain
      // authoritative so the native callback buffer can be acknowledged.
      logger.warn(
        { err },
        "[AndroidCloudClient] pending login cleanup deferred after terminal authentication failure",
      );
    }
  }

  async completeLogin(
    callbackUrl: string,
    signal?: AbortSignal,
  ): Promise<AndroidCloudLoginCompletion> {
    signal?.throwIfAborted();
    const storedPending = await this.pendingLoginStore.read();
    const pending =
      (storedPending ? parsePendingLogin(storedPending) : null) ??
      this.pendingLogin;
    const { callback, returnedState } = parseCanonicalCallback(callbackUrl);
    if (!pending) {
      throw new AndroidCloudAuthError("No Eliza Cloud sign-in is waiting.", {
        attemptId: returnedState,
        disposition: "acknowledge",
      });
    }
    if (!returnedState || returnedState !== pending.state) {
      throw new AndroidCloudAuthError(
        "Eliza Cloud sign-in state did not match this device.",
        { attemptId: returnedState, disposition: "acknowledge" },
      );
    }
    const callbackError = singleCallbackValue(callback, "error");
    if (callbackError) {
      await this.clearTerminalLogin(pending.state);
      throw new AndroidCloudAuthError(
        singleCallbackValue(callback, "error_description") ||
          "Eliza Cloud sign-in was cancelled.",
        { attemptId: pending.state, disposition: "acknowledge" },
      );
    }
    const code = singleCallbackValue(callback, "code");
    if (!code) {
      await this.clearTerminalLogin(pending.state);
      throw new AndroidCloudAuthError(
        "Eliza Cloud returned no authorization code.",
        { attemptId: pending.state, disposition: "acknowledge" },
      );
    }

    const completionApiBase = apiBaseForEnvironment(pending.environment);

    const tokenRequest = {
      clientId: pending.clientId,
      environment: pending.environment,
      grantType: "authorization_code",
      redirectUri: pending.redirectUri,
      state: pending.state,
      code,
      codeVerifier: pending.codeVerifier,
    };
    let terminalFailure = false;
    try {
      const tokenResponse = await this.fetchImpl(
        `${completionApiBase}/api/v1/app-auth/mobile/token`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tokenRequest),
        },
      );
      const exchanged = await responseJson(tokenResponse);
      if (!tokenResponse.ok) {
        const failure = protocolFailure(
          mobileAuthResponseError(
            exchanged,
            "Eliza Cloud could not create a mobile session.",
          ),
          tokenResponse.status,
          pending.state,
        );
        terminalFailure = failure.disposition === "acknowledge";
        throw failure;
      }
      const secret = stringField(exchanged.secret);
      const credentialId = stringField(exchanged.credentialId);
      if (!secret || !credentialId)
        throw new AndroidCloudAuthError(
          "Eliza Cloud returned an invalid mobile session.",
          { attemptId: pending.state, disposition: "retry" },
        );

      signal?.throwIfAborted();
      const previousSecret = await this.credentialStore.read();
      try {
        await this.credentialStore.write(secret);
        if ((await this.credentialStore.read()) !== secret) {
          throw new AndroidCloudAuthError(
            "Eliza Cloud could not durably store the mobile session.",
            { attemptId: pending.state, disposition: "retry" },
          );
        }
        const acknowledgeResponse = await this.fetchImpl(
          `${completionApiBase}/api/v1/app-auth/mobile/ack`,
          {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clientId: pending.clientId,
              environment: pending.environment,
              redirectUri: pending.redirectUri,
              state: pending.state,
              code,
              codeVerifier: pending.codeVerifier,
              credentialId,
              secret,
            }),
          },
        );
        const acknowledged = await responseJson(acknowledgeResponse);
        if (!acknowledgeResponse.ok) {
          const failure = protocolFailure(
            mobileAuthResponseError(
              acknowledged,
              "Eliza Cloud could not activate the mobile session.",
            ),
            acknowledgeResponse.status,
            pending.state,
          );
          terminalFailure = failure.disposition === "acknowledge";
          throw failure;
        }
        if (
          acknowledged.success !== true ||
          acknowledged.status !== "acknowledged" ||
          stringField(acknowledged.credentialId) !== credentialId
        ) {
          throw new AndroidCloudAuthError(
            "Eliza Cloud returned an invalid mobile session acknowledgement.",
            { attemptId: pending.state, disposition: "retry" },
          );
        }
      } catch (error) {
        if (previousSecret) await this.credentialStore.write(previousSecret);
        else await this.credentialStore.clear();
        throw error;
      }
      let pendingCleanupRequired = false;
      try {
        await this.cancelLogin(pending.state);
      } catch (err) {
        // The credential write and server acknowledgement are the commit point.
        // A protected-store cleanup failure must not roll back an activated
        // session; callers retain this explicit signal for later cleanup.
        // error-policy:J4 the authenticated session remains valid while this
        // explicit cleanup signal and diagnostic preserve the degraded state.
        logger.warn(
          { err },
          "[AndroidCloudClient] pending login cleanup deferred after authentication",
        );
        pendingCleanupRequired = true;
      }
      return {
        apiBase: completionApiBase,
        pendingCleanupRequired,
        state: pending.state,
      };
    } catch (error) {
      if (terminalFailure) await this.clearTerminalLogin(pending.state);
      if (error instanceof AndroidCloudAuthError) throw error;
      throw new AndroidCloudAuthError(
        "Eliza Cloud sign-in was interrupted. Please try again.",
        { attemptId: pending.state, cause: error, disposition: "retry" },
      );
    }
  }

  async sendChat(
    session: AndroidCloudSession,
    conversationId: string,
    text: string,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!conversationId.trim())
      throw new Error("A conversation is required before sending.");
    const response = await this.fetchImpl(
      `${session.chatApiBase}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          channelType: "DM",
        }),
      },
    );
    if (!response.ok) {
      const body = await responseJson(response);
      throw new Error(
        responseError(body, `Eliza could not answer (${response.status}).`),
      );
    }
    const body = await responseJson(response);
    const reply = stringField(body.text) ?? "";
    if (!reply) throw new Error("Eliza finished without a reply.");
    onText(reply);
    return reply;
  }

  async createConversation(session: AndroidCloudSession): Promise<string> {
    const response = await this.fetchImpl(
      `${session.chatApiBase}/api/conversations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Android chat" }),
      },
    );
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(
        responseError(
          body,
          `Unable to open a conversation (${response.status}).`,
        ),
      );
    }
    const conversation = record(body.conversation);
    const id = stringField(conversation?.id);
    if (!id) throw new Error("Eliza Cloud returned an invalid conversation.");
    return id;
  }

  async signOut(): Promise<void> {
    const token = await this.readToken();
    try {
      if (token) {
        await this.fetchImpl(`${this.apiBase}/api/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // error-policy:J6 remote logout is best-effort teardown; the authoritative
      // local credential removal is awaited in the finally block below.
    } finally {
      await this.credentialStore.clear();
    }
  }

  async getConversationMessages(
    session: AndroidCloudSession,
    conversationId: string,
  ): Promise<AndroidCloudTranscriptMessage[]> {
    const response = await this.fetchImpl(
      `${session.chatApiBase}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(
        responseError(
          body,
          `Unable to restore the conversation (${response.status}).`,
        ),
      );
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.flatMap((value): AndroidCloudTranscriptMessage[] => {
      const item = record(value);
      const id = stringField(item?.id);
      const role = stringField(item?.role);
      const text = stringField(item?.text);
      if (!id || (role !== "user" && role !== "assistant") || !text) return [];
      return [{ id, role, text }];
    });
  }
}
