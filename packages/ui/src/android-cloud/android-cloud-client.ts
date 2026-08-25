/**
 * Small, Cloud-only transport used by the Play-safe Android consumer shell.
 *
 * This module deliberately has no dependency on ElizaClient, AppContext, the
 * desktop/native-agent transports, or any plugin registry. Every request is
 * pinned to the canonical Eliza Cloud API or to an HTTPS runtime authority
 * returned by that API.
 */

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  directCloudAppBaseForApi,
  resolveCanonicalDirectCloudApiBase,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
} from "../api/direct-cloud-endpoints";

const MANAGED_RUNTIME_HOST_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cloud(?:-staging)?\.eliza\.app$/i;
const MOBILE_APP_AUTH_CLIENT_ID = "ai.elizaos.app";
const MOBILE_APP_AUTH_REDIRECT_URI = "https://eliza.app/auth/callback";

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
}

export interface AndroidCloudCredentialStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

const browserCredentialStore: AndroidCloudCredentialStore = {
  async read() {
    return readStoredStewardToken()?.trim() || null;
  },
  async write(token) {
    writeStoredStewardToken(token);
  },
  async clear() {
    clearStoredStewardToken();
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
  private pendingLogin: AndroidCloudPendingLogin | null = null;

  constructor(options: AndroidCloudClientOptions = {}) {
    this.apiBase = resolveCanonicalDirectCloudApiBase(options.cloudApiBase);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentialStore = options.credentialStore ?? browserCredentialStore;
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
    const configResponse = await this.fetchImpl(configUrl);
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

    this.pendingLogin = {
      clientId,
      codeVerifier,
      environment,
      redirectUri,
      state,
    };

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

  cancelLogin(): void {
    this.pendingLogin = null;
  }

  async completeLogin(
    callbackUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const pending = this.pendingLogin;
    if (!pending) throw new Error("No Eliza Cloud sign-in is waiting.");
    let callback: URL;
    try {
      callback = new URL(callbackUrl);
    } catch {
      throw new Error("Eliza Cloud returned an invalid app callback.");
    }
    if (
      callback.protocol !== "elizaos:" ||
      [callback.host, callback.pathname]
        .join("/")
        .replace(/\/+/g, "/")
        .replace(/^\/+|\/+$/g, "") !== "auth/callback"
    ) {
      throw new Error("Eliza Cloud returned an untrusted app callback.");
    }
    const returnedState = callback.searchParams.get("state")?.trim();
    if (!returnedState || returnedState !== pending.state) {
      throw new Error("Eliza Cloud sign-in state did not match this device.");
    }
    const callbackError = callback.searchParams.get("error")?.trim();
    if (callbackError) {
      this.pendingLogin = null;
      throw new Error(
        callback.searchParams.get("error_description")?.trim() ||
          "Eliza Cloud sign-in was cancelled.",
      );
    }
    const code = callback.searchParams.get("code")?.trim();
    if (!code) throw new Error("Eliza Cloud returned no authorization code.");

    const tokenRequest = {
      clientId: pending.clientId,
      environment: pending.environment,
      grantType: "authorization_code",
      redirectUri: pending.redirectUri,
      state: pending.state,
      code,
      codeVerifier: pending.codeVerifier,
    };
    const tokenResponse = await this.fetchImpl(
      `${this.apiBase}/api/v1/app-auth/mobile/token`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenRequest),
      },
    );
    const exchanged = await responseJson(tokenResponse);
    if (!tokenResponse.ok) {
      throw new Error(
        mobileAuthResponseError(
          exchanged,
          "Eliza Cloud could not create a mobile session.",
        ),
      );
    }
    const secret = stringField(exchanged.secret);
    const credentialId = stringField(exchanged.credentialId);
    if (!secret || !credentialId)
      throw new Error("Eliza Cloud returned an invalid mobile session.");

    signal?.throwIfAborted();
    const previousSecret = await this.credentialStore.read();
    await this.credentialStore.write(secret);
    try {
      const acknowledgeResponse = await this.fetchImpl(
        `${this.apiBase}/api/v1/app-auth/mobile/ack`,
        {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...tokenRequest, credentialId, secret }),
        },
      );
      const acknowledged = await responseJson(acknowledgeResponse);
      if (!acknowledgeResponse.ok) {
        throw new Error(
          mobileAuthResponseError(
            acknowledged,
            "Eliza Cloud could not activate the mobile session.",
          ),
        );
      }
      if (
        acknowledged.success !== true ||
        acknowledged.status !== "acknowledged" ||
        stringField(acknowledged.credentialId) !== credentialId
      ) {
        throw new Error(
          "Eliza Cloud returned an invalid mobile session acknowledgement.",
        );
      }
      this.pendingLogin = null;
    } catch (error) {
      if (previousSecret) await this.credentialStore.write(previousSecret);
      else await this.credentialStore.clear();
      throw error;
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
