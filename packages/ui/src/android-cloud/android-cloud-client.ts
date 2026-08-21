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
const CANCELLED_CREDENTIAL_TOMBSTONE = "eliza_cancelled_login_credential_v1";
const PENDING_LOGIN_CREDENTIAL_PREFIX = "eliza_pending_login_credential_v1:";
const LOGIN_CREDENTIAL_JOURNAL_PREFIX = "eliza_login_credential_journal_v2:";
const DEFAULT_LOGIN_REVOCATION_TIMEOUT_MS = 5_000;

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
  loginRevocationTimeoutMs?: number;
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

interface PendingLoginCredential {
  sessionId: string;
  token: string;
}

interface StoredCredentialState {
  activeToken: string | null;
  activeSessionId: string | null;
  pending: PendingLoginCredential[];
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodePendingLoginCredential(
  value: string | null,
): PendingLoginCredential | null {
  if (!value?.startsWith(PENDING_LOGIN_CREDENTIAL_PREFIX)) return null;
  try {
    const parsed = record(
      JSON.parse(value.slice(PENDING_LOGIN_CREDENTIAL_PREFIX.length)),
    );
    const sessionId = stringField(parsed?.sessionId);
    const token = stringField(parsed?.token);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || !token) {
      return null;
    }
    return { sessionId, token };
  } catch {
    return null;
  }
}

function emptyCredentialState(): StoredCredentialState {
  return { activeToken: null, activeSessionId: null, pending: [] };
}

function invalidCredentialState(cause?: unknown): never {
  // error-policy:J3 an unreadable secure-store envelope must remain untouched;
  // treating it as empty could overwrite live revocation ownership.
  throw new Error("The stored sign-in credential journal is invalid.", {
    cause,
  });
}

function decodeCredentialState(value: string | null): StoredCredentialState {
  const stored = value?.trim() || null;
  if (!stored || stored === CANCELLED_CREDENTIAL_TOMBSTONE) {
    return emptyCredentialState();
  }
  const legacyPending = decodePendingLoginCredential(stored);
  if (legacyPending) {
    return {
      activeToken: null,
      activeSessionId: null,
      pending: [legacyPending],
    };
  }
  if (stored.startsWith(PENDING_LOGIN_CREDENTIAL_PREFIX)) {
    return invalidCredentialState();
  }
  if (!stored.startsWith(LOGIN_CREDENTIAL_JOURNAL_PREFIX)) {
    return { activeToken: stored, activeSessionId: null, pending: [] };
  }
  try {
    const parsed = record(
      JSON.parse(stored.slice(LOGIN_CREDENTIAL_JOURNAL_PREFIX.length)),
    );
    if (!parsed) return invalidCredentialState();
    const activeToken =
      parsed.activeToken === null || parsed.activeToken === undefined
        ? null
        : stringField(parsed.activeToken);
    if (
      parsed.activeToken !== null &&
      parsed.activeToken !== undefined &&
      !activeToken
    ) {
      return invalidCredentialState();
    }
    const activeSessionId =
      parsed.activeSessionId === null || parsed.activeSessionId === undefined
        ? null
        : stringField(parsed.activeSessionId);
    const hasActiveSessionId =
      parsed.activeSessionId !== null && parsed.activeSessionId !== undefined;
    if (
      (hasActiveSessionId &&
        (!activeSessionId || !SESSION_ID_PATTERN.test(activeSessionId))) ||
      (hasActiveSessionId && activeToken === null)
    ) {
      return invalidCredentialState();
    }
    if (!Array.isArray(parsed.pending)) return invalidCredentialState();
    const pending: PendingLoginCredential[] = [];
    const sessions = new Set<string>();
    for (const value of parsed.pending) {
      const item = record(value);
      const sessionId = stringField(item?.sessionId);
      const token = stringField(item?.token);
      if (
        !sessionId ||
        !SESSION_ID_PATTERN.test(sessionId) ||
        !token ||
        sessions.has(sessionId)
      ) {
        return invalidCredentialState();
      }
      sessions.add(sessionId);
      pending.push({ sessionId, token });
    }
    if (activeSessionId) {
      const activeReceipt = pending.find(
        (credential) => credential.sessionId === activeSessionId,
      );
      if (activeReceipt && activeReceipt.token !== activeToken) {
        return invalidCredentialState();
      }
    }
    return { activeToken, activeSessionId, pending };
  } catch (error) {
    return invalidCredentialState(error);
  }
}

function encodeCredentialState(state: StoredCredentialState): string | null {
  if (state.pending.length === 0 && state.activeSessionId === null) {
    return state.activeToken;
  }
  return `${LOGIN_CREDENTIAL_JOURNAL_PREFIX}${JSON.stringify(state)}`;
}

function hasPendingCredential(
  state: StoredCredentialState,
  credential: PendingLoginCredential,
): boolean {
  return state.pending.some(
    (pending) =>
      pending.sessionId === credential.sessionId &&
      pending.token === credential.token,
  );
}

function hasActiveCredential(
  state: StoredCredentialState,
  credential: PendingLoginCredential,
): boolean {
  return (
    state.activeSessionId === credential.sessionId &&
    state.activeToken === credential.token
  );
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
  private readonly loginRevocationTimeoutMs: number;
  private credentialMutation: Promise<void> = Promise.resolve();
  private credentialRevision = 0;
  private readonly loginCredentials = new Map<string, { token: string }>();
  private readonly locallyDeliveredCredentials = new Map<string, string>();

  constructor(options: AndroidCloudClientOptions = {}) {
    this.apiBase = resolveCanonicalDirectCloudApiBase(options.cloudApiBase);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentialStore = options.credentialStore ?? browserCredentialStore;
    this.loginRevocationTimeoutMs =
      options.loginRevocationTimeoutMs ?? DEFAULT_LOGIN_REVOCATION_TIMEOUT_MS;
  }

  async readToken(): Promise<string | null> {
    return (await this.readTokenSnapshot()).token;
  }

  private async readTokenSnapshot(): Promise<{
    token: string | null;
    sessionId: string | null;
    revision: number;
  }> {
    const snapshot = await this.mutateCredential(async () => ({
      state: decodeCredentialState(await this.credentialStore.read()),
      revision: this.credentialRevision,
    }));
    const recoveredPending = snapshot.state.pending.filter(
      (pending) =>
        this.locallyDeliveredCredentials.get(pending.sessionId) !==
        pending.token,
    );
    for (const pending of recoveredPending) {
      this.loginCredentials.set(pending.sessionId, { token: pending.token });
    }
    if (snapshot.state.activeToken && snapshot.state.activeSessionId) {
      this.loginCredentials.set(snapshot.state.activeSessionId, {
        token: snapshot.state.activeToken,
      });
    }
    const cleanupResults = await Promise.allSettled(
      recoveredPending.map((pending) =>
        this.discardLoginAttempt(pending.sessionId, pending.token),
      ),
    );
    const cleanupErrors = cleanupResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(
        cleanupErrors,
        "Stored sign-in credentials could not be revoked.",
      );
    }
    return this.mutateCredential(async () => {
      const state = decodeCredentialState(await this.credentialStore.read());
      return {
        token: state.activeToken,
        sessionId: state.activeSessionId,
        revision: this.credentialRevision,
      };
    });
  }

  private mutateCredential<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.credentialMutation.then(operation, operation);
    this.credentialMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private writePendingLoginCredential(
    credential: PendingLoginCredential,
  ): Promise<number> {
    return this.mutateCredential(async () => {
      const state = decodeCredentialState(await this.credentialStore.read());
      const sameSession = state.pending.find(
        (pending) => pending.sessionId === credential.sessionId,
      );
      if (sameSession && sameSession.token !== credential.token) {
        throw new Error("Sign-in credential ownership changed.");
      }
      if (!sameSession) state.pending.push(credential);
      return this.persistCredentialState(state);
    });
  }

  private promotePendingLoginCredential(
    credential: PendingLoginCredential,
  ): Promise<number> {
    return this.mutateCredential(async () => {
      const state = decodeCredentialState(await this.credentialStore.read());
      if (!hasPendingCredential(state, credential)) {
        throw new DOMException(
          "Sign-in credential ownership changed.",
          "AbortError",
        );
      }
      state.activeToken = credential.token;
      state.activeSessionId = credential.sessionId;
      return this.persistCredentialState(state);
    });
  }

  private async persistCredentialState(
    state: StoredCredentialState,
  ): Promise<number> {
    const encoded = encodeCredentialState(state);
    if (encoded === null) await this.credentialStore.clear();
    else await this.credentialStore.write(encoded);
    this.credentialRevision += 1;
    return this.credentialRevision;
  }

  private clearToken(): Promise<void> {
    return this.mutateCredential(async () => {
      const state = decodeCredentialState(await this.credentialStore.read());
      state.activeToken = null;
      state.activeSessionId = null;
      await this.persistCredentialState(state);
    });
  }

  private clearTokenIfCurrent(
    expectedToken: string,
    expectedRevision?: number,
  ): Promise<boolean> {
    return this.mutateCredential(async () => {
      if (
        expectedRevision !== undefined &&
        this.credentialRevision !== expectedRevision
      ) {
        return false;
      }
      const state = decodeCredentialState(await this.credentialStore.read());
      if (state.activeToken !== expectedToken) return false;
      state.activeToken = null;
      state.activeSessionId = null;
      await this.persistCredentialState(state);
      return true;
    });
  }

  async restoreSession(): Promise<AndroidCloudSession | null> {
    const { token, sessionId, revision } = await this.readTokenSnapshot();
    if (!token) return null;
    const response = await this.fetchImpl(
      `${this.apiBase}/api/v1/eliza/personal`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (response.status === 401) {
      if (sessionId) await this.discardLoginAttempt(sessionId, token);
      else await this.clearTokenIfCurrent(token, revision);
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
      `${this.apiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}?delivery=acknowledgement-required`,
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
      const pendingCredential = { sessionId, token };
      this.loginCredentials.set(sessionId, { token });
      try {
        await this.writePendingLoginCredential(pendingCredential);
        signal?.throwIfAborted();
        await this.acknowledgeLoginCredential(sessionId, token, signal);
        signal?.throwIfAborted();
        await this.promotePendingLoginCredential(pendingCredential);
        this.loginCredentials.set(sessionId, { token });
        this.locallyDeliveredCredentials.set(sessionId, token);
        signal?.throwIfAborted();
      } catch (acknowledgementError) {
        try {
          await this.discardLoginAttempt(sessionId, token);
        } catch (cleanupError) {
          throw new AggregateError(
            [acknowledgementError, cleanupError],
            "Sign-in delivery could not be acknowledged or revoked.",
          );
        }
        throw acknowledgementError;
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
      await this.clearToken();
    }
  }

  async acceptLoginAttempt(sessionId: string, token: string): Promise<void> {
    const credential = { sessionId, token: token.trim() };
    if (!credential.token) return;
    const owned = this.loginCredentials.get(sessionId);
    if (!owned || owned.token !== credential.token) {
      throw new Error(
        "The accepted sign-in credential does not match its attempt.",
      );
    }
    await this.mutateCredential(async () => {
      const state = decodeCredentialState(await this.credentialStore.read());
      if (!hasActiveCredential(state, credential)) {
        throw new Error("The accepted sign-in credential is no longer active.");
      }
      if (!hasPendingCredential(state, credential)) {
        throw new Error(
          "The accepted sign-in credential has no cleanup receipt.",
        );
      }
      state.pending = state.pending.filter(
        (pending) => pending.sessionId !== sessionId,
      );
      // Once the UI has verified the session, the active bearer can collapse
      // back to the legacy plain-token representation. Other pending attempts
      // remain in the journal and cannot be overwritten by this acceptance.
      state.activeSessionId = null;
      await this.persistCredentialState(state);
    });
    this.loginCredentials.delete(sessionId);
    this.locallyDeliveredCredentials.delete(sessionId);
  }

  private async acknowledgeLoginCredential(
    sessionId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = window.setTimeout(
      () => controller.abort(),
      this.loginRevocationTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(
        `${this.apiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `The sign-in credential delivery could not be acknowledged (${response.status}).`,
        );
      }
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async discardLoginAttempt(sessionId: string, token: string): Promise<void> {
    const expectedToken = token.trim();
    if (!expectedToken) return;
    this.locallyDeliveredCredentials.delete(sessionId);
    const owned = this.loginCredentials.get(sessionId);
    if (!owned) return;
    if (owned.token !== expectedToken) {
      throw new Error(
        "The canceled sign-in credential does not match its attempt.",
      );
    }

    const credential = { sessionId, token: expectedToken };
    const neutralizeStoredCredential = () =>
      this.mutateCredential(async () => {
        const state = decodeCredentialState(await this.credentialStore.read());
        const ownsStoredCredential =
          hasActiveCredential(state, credential) ||
          hasPendingCredential(state, credential);
        if (!ownsStoredCredential) return;
        if (hasActiveCredential(state, credential)) {
          state.activeToken = null;
          state.activeSessionId = null;
        }
        state.pending = state.pending.filter(
          (pending) => pending.sessionId !== sessionId,
        );
        try {
          await this.persistCredentialState(state);
        } catch (clearError) {
          if (state.activeToken !== null || state.pending.length > 0) {
            throw clearError;
          }
          try {
            await this.credentialStore.write(CANCELLED_CREDENTIAL_TOMBSTONE);
            this.credentialRevision += 1;
          } catch (tombstoneError) {
            throw new AggregateError(
              [clearError, tombstoneError],
              "The canceled sign-in credential could not be removed.",
            );
          }
        }
      });

    let quarantineError: unknown;
    try {
      await this.mutateCredential(async () => {
        const state = decodeCredentialState(await this.credentialStore.read());
        const ownsStoredCredential =
          hasActiveCredential(state, credential) ||
          hasPendingCredential(state, credential);
        if (!ownsStoredCredential) return;
        if (hasActiveCredential(state, credential)) {
          state.activeToken = null;
          state.activeSessionId = null;
        }
        if (!hasPendingCredential(state, credential)) {
          state.pending.push(credential);
        }
        await this.persistCredentialState(state);
      });
    } catch (error) {
      quarantineError = error;
    }

    // Keep the non-authenticating secure-store record until the server has
    // confirmed revocation. A response-loss retry or process restart can then
    // recover both the session binding and exact bearer without exposing it to
    // ordinary session restoration.
    let revocationError: unknown;
    try {
      await this.revokeLoginCredential(sessionId, expectedToken);
    } catch (error) {
      revocationError = error;
    }
    if (revocationError) {
      if (quarantineError) {
        let neutralizationError: unknown;
        try {
          // Neither durable retry nor server revocation succeeded. Fail closed
          // locally if possible so a reboot cannot authenticate the canceled
          // bearer; the in-memory ownership record still permits a retry.
          await neutralizeStoredCredential();
        } catch (error) {
          neutralizationError = error;
        }
        throw new AggregateError(
          [quarantineError, revocationError, neutralizationError].filter(
            (error) => error !== undefined,
          ),
          "The canceled sign-in credential could not be quarantined or revoked.",
        );
      }
      throw revocationError;
    }

    await neutralizeStoredCredential();
    this.loginCredentials.delete(sessionId);
  }

  private async revokeLoginCredential(
    sessionId: string,
    token: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      this.loginRevocationTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(
        `${this.apiBase}/api/auth/cli-session/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(
          `The canceled sign-in credential could not be revoked (${response.status}).`,
        );
      }
    } catch (error) {
      throw new Error("The canceled sign-in credential could not be revoked.", {
        cause: error,
      });
    } finally {
      window.clearTimeout(timeout);
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
