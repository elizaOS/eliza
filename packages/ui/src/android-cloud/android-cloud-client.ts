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
} from "../api/direct-cloud-endpoints";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_RUNTIME_HOST_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.cloud(?:-staging)?\.eliza\.app$/i;

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
  sessionId: string;
  browserUrl: string;
}

export type AndroidCloudLoginPoll =
  | { status: "pending" }
  | { status: "expired"; error: string }
  | { status: "authenticated"; token: string };

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
    await writeStoredStewardToken(token);
  },
  async clear() {
    await clearStoredStewardToken();
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
  // a malformed 200 look like "no session yet", so pollLogin spun for its full
  // ten minutes instead of reporting that Cloud returned something unusable.
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
    const requestId = globalThis.crypto?.randomUUID?.();
    if (!requestId || !SESSION_ID_PATTERN.test(requestId)) {
      throw new Error("Secure sign-in is unavailable on this device.");
    }
    const response = await this.fetchImpl(
      `${this.apiBase}/api/auth/cli-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: requestId }),
      },
    );
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(
        responseError(body, `Unable to start sign-in (${response.status}).`),
      );
    }
    const sessionId = stringField(body.sessionId);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("Eliza Cloud returned an invalid sign-in session.");
    }
    // Pair the login origin with the API the session was minted against: a
    // staging build must not send users to the production login, where the
    // session it just created does not exist.
    const url = new URL(
      "/auth/cli-login",
      directCloudAppBaseForApi(this.apiBase),
    );
    url.searchParams.set("session", sessionId);
    return { sessionId, browserUrl: url.toString() };
  }

  async pollLogin(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<AndroidCloudLoginPoll> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("The sign-in session is invalid.");
    }
    const response = await this.fetchImpl(
      `${this.apiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
      { signal },
    );
    if (response.status === 404) {
      return { status: "expired", error: "Sign-in expired. Please try again." };
    }
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(
        responseError(body, `Unable to finish sign-in (${response.status}).`),
      );
    }
    const data = record(body.data) ?? body;
    const status = stringField(data.status)?.toLowerCase();
    if (status === "authenticated") {
      const token =
        stringField(data.token) ??
        stringField(data.apiKey) ??
        stringField(data.accessToken) ??
        stringField(data.access_token);
      if (!token) throw new Error("Sign-in completed without a session token.");
      signal?.throwIfAborted();
      await this.credentialStore.write(token);
      if (signal?.aborted) {
        await this.credentialStore.clear();
        signal.throwIfAborted();
      }
      return { status: "authenticated", token };
    }
    if (status === "expired" || status === "error") {
      return {
        status: "expired",
        error: responseError(data, "Sign-in expired. Please try again."),
      };
    }
    return { status: "pending" };
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
      // Remote logout is best-effort. Local credential removal is authoritative
      // for this device and must still complete while offline.
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
