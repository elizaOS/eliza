/**
 * OAuth flow orchestration registry.
 *
 * Wraps the provider-specific programmatic OAuth helpers
 * (`startAnthropicOAuthFlowRaw` from
 * `vendor/pi-oauth/anthropic-login.ts` and the loopback-listener flow
 * in `openai-codex.ts`) with:
 *
 *   - a 15-minute timeout per flow,
 *   - automatic `saveAccount(...)` after token exchange,
 *   - an in-memory registry keyed by `sessionId` so the HTTP API can
 *     stream progress over SSE and the CLI can `await` completion,
 *   - garbage collection 10 minutes after a flow reaches a terminal
 *     state.
 *
 * Both the CLI and the new accounts-routes HTTP endpoints drive flows
 * through this module — there is no direct caller of the vendor-level
 * OAuth helpers anymore.
 */

import crypto from "node:crypto";
import { ElizaError, logger } from "@elizaos/core";
import {
  type AccountCredentialRecord,
  listAccounts,
  loadAccount,
  saveAccount,
} from "./account-storage.ts";
import { startCodexDeviceLogin } from "./codex-device.ts";
import type { CodexFlow } from "./openai-codex.ts";
import { startCodexLogin } from "./openai-codex.ts";
import type { SubscriptionProvider } from "./types.ts";
import {
  type AnthropicOAuthCredentials,
  startAnthropicOAuthFlowRaw,
} from "./vendor/pi-oauth/anthropic-login.ts";

/** Server-tracked status of an in-flight OAuth flow. */
export type FlowStatus =
  | "pending"
  | "success"
  | "error"
  | "cancelled"
  | "timeout";

/**
 * Credential-free projection of an `AccountCredentialRecord` — the only
 * account shape allowed into {@link FlowState}. `FlowState` is serialized
 * verbatim to every `/api/accounts/:provider/oauth/status` SSE subscriber,
 * so the OAuth access/refresh tokens must never enter it. In-process
 * callers that need the tokens use `OAuthFlowHandle.completion` instead.
 */
export type FlowAccountSummary = Omit<AccountCredentialRecord, "credentials">;

export interface FlowState {
  sessionId: string;
  providerId: SubscriptionProvider;
  status: FlowStatus;
  /** Set on `pending` (so the UI can re-open the browser) and on `success`. */
  authUrl?: string;
  /** Whether the client must offer a callback URL/code input. */
  needsCodeSubmission: boolean;
  /** Existing account selected by the initiating request for atomic replacement. */
  replaceAccountId?: string;
  account?: FlowAccountSummary;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface OAuthFlowHandle {
  sessionId: string;
  authUrl: string;
  /** One-time code entered on the provider's device authorization page. */
  userCode?: string;
  /** Whether the client must offer a callback URL/code input. */
  needsCodeSubmission: boolean;
  /** Resolves with the saved AccountCredentialRecord; rejects on cancel/timeout/error. */
  completion: Promise<{ account: AccountCredentialRecord }>;
  /** Submit the provider's callback URL or authorization code. */
  submitCode: (code: string) => void;
  cancel: (reason?: string) => void;
}

// Browser subscription login can include MFA, account selection, and consent.
// Five minutes routinely expired before a remote user could copy the loopback
// callback URL back into Eliza, destroying the PKCE verifier. Keep the verifier
// in memory long enough for a normal interactive login while retaining a hard
// upper bound and terminal-state cleanup.
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const FLOW_GC_MS = 10 * 60 * 1000;

interface InternalFlowEntry {
  state: FlowState;
  handle: OAuthFlowHandle;
  listeners: Set<(state: FlowState) => void>;
  gcTimer?: ReturnType<typeof setTimeout>;
}

const flows = new Map<string, InternalFlowEntry>();

function newSessionId(): string {
  return crypto.randomUUID();
}

function emit(entry: InternalFlowEntry): void {
  for (const listener of entry.listeners) {
    listener(entry.state);
  }
}

function scheduleGc(sessionId: string): void {
  const entry = flows.get(sessionId);
  if (!entry) return;
  if (entry.gcTimer) clearTimeout(entry.gcTimer);
  entry.gcTimer = setTimeout(() => {
    flows.delete(sessionId);
  }, FLOW_GC_MS);
}

function resolveAccountId(opts: { accountId?: string }): string {
  return opts.accountId?.trim() || crypto.randomUUID();
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function assertReplacementIdentity(
  existing: AccountCredentialRecord,
  incoming: {
    organizationId?: string;
    providerAccountId?: string;
    email?: string;
  },
): void {
  const comparisons = [
    ["organization", existing.organizationId, incoming.organizationId],
    ["user", existing.userId, incoming.providerAccountId],
    [
      "email",
      normalizeIdentity(existing.email),
      normalizeIdentity(incoming.email),
    ],
  ] as const;
  for (const [field, expected, actual] of comparisons) {
    if (!expected) continue;
    if (!actual || expected !== actual) {
      throw new ElizaError(
        `OAuth replacement ${field} identity does not match`,
        {
          code: "oauth_flow.replacement_identity_mismatch",
          severity: "fatal",
          context: { field },
        },
      );
    }
  }
}

/** Build the canonical account record without mutating credential storage. */
function buildAccountRecord(args: {
  providerId: SubscriptionProvider;
  accountId: string;
  replaceAccountId?: string;
  label: string;
  access: string;
  refresh: string;
  expires: number;
  idToken?: string;
  organizationId?: string;
  providerAccountId?: string;
  email?: string;
}): { record: AccountCredentialRecord; previous?: AccountCredentialRecord } {
  const now = Date.now();
  const normalizedEmail = normalizeIdentity(args.email);
  const replacement = args.replaceAccountId
    ? loadAccount(args.providerId, args.replaceAccountId)
    : null;
  if (args.replaceAccountId && !replacement) {
    throw new ElizaError("OAuth replacement account no longer exists", {
      code: "oauth_flow.replacement_target_missing",
      severity: "fatal",
      context: {
        providerId: args.providerId,
        accountId: args.replaceAccountId,
      },
    });
  }
  if (replacement) {
    assertReplacementIdentity(replacement, {
      organizationId: args.organizationId,
      providerAccountId: args.providerAccountId,
      email: args.email,
    });
  }
  const deduplicated = replacement
    ? null
    : listAccounts(args.providerId).find((account) => {
        if (
          args.organizationId &&
          account.organizationId === args.organizationId
        ) {
          return true;
        }
        return Boolean(
          normalizedEmail &&
            normalizeIdentity(account.email) === normalizedEmail,
        );
      });
  const existing = replacement ?? deduplicated;
  const record: AccountCredentialRecord = {
    id: existing?.id ?? args.accountId,
    providerId: args.providerId,
    label: replacement?.label ?? args.email ?? args.label,
    source: "oauth",
    credentials: {
      access: args.access,
      refresh: args.refresh,
      expires: args.expires,
      ...(args.idToken ? { idToken: args.idToken } : {}),
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    ...(args.providerAccountId
      ? { userId: args.providerAccountId }
      : existing?.userId
        ? { userId: existing.userId }
        : {}),
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(args.email ? { email: args.email } : {}),
  };
  return { record, ...(replacement ? { previous: replacement } : {}) };
}

interface StartOptions {
  label: string;
  accountId?: string;
  /** Existing same-provider account to replace only after OAuth succeeds. */
  replaceAccountId?: string;
  /** Remote/headless clients use Codex device auth instead of loopback PKCE. */
  headless?: boolean;
  /**
   * Called after the account is saved on disk. Used by the HTTP
   * route layer to also write a `LinkedAccountConfig` row into
   * `eliza.json`. Failures here propagate as flow `error`.
   */
  onAccountSaved?: (account: AccountCredentialRecord) => void | Promise<void>;
  /** Restores host metadata if replacement adoption fails after a pool write. */
  onReplacementRollback?: (
    account: AccountCredentialRecord,
  ) => void | Promise<void>;
}

// Anthropic.

/**
 * Start a programmatic Anthropic OAuth flow. Anthropic's redirect URI
 * is hardcoded to `console.anthropic.com/oauth/code/callback` — the
 * UI must surface the auth URL, prompt the user to copy the
 * `code#state` blob, and call `submitCode()` with it. Once the code is
 * submitted, the token exchange runs and the account is persisted.
 */
export function startAnthropicOAuthFlow(
  opts: StartOptions,
): Promise<OAuthFlowHandle> {
  return startGenericFlow({
    providerId: "anthropic-subscription",
    opts,
    needsCodeSubmission: true,
    begin: async () => {
      const raw = await startAnthropicOAuthFlowRaw();
      const completion = (async (): Promise<{
        creds: AnthropicOAuthCredentials;
      }> => {
        const creds = await raw.completion;
        return { creds };
      })();
      return {
        authUrl: raw.authUrl,
        completion,
        submitCode: raw.submitCode,
        cancel: raw.cancel,
      };
    },
  });
}

// Codex (OpenAI ChatGPT subscription).

/**
 * Start a programmatic Codex OAuth flow. Native/local clients can use the
 * loopback listener on :1455. Remote web clients must paste the localhost
 * callback URL because that URL resolves in the browser's device, not on the
 * remote Eliza host. The accountId
 * baked into the JWT is preserved on `LinkedAccountConfig.organizationId`
 * (used by the Codex usage probe via the `ChatGPT-Account-Id` header).
 */
export function startCodexOAuthFlow(
  opts: StartOptions,
): Promise<OAuthFlowHandle> {
  if (opts.headless) {
    return startGenericFlow({
      providerId: "openai-codex",
      opts,
      needsCodeSubmission: false,
      begin: async () => {
        const flow = await startCodexDeviceLogin();
        return {
          authUrl: flow.authUrl,
          userCode: flow.userCode,
          completion: flow.credentials.then((creds) => ({ creds })),
          submitCode: () => undefined,
          cancel: () => flow.close(),
        };
      },
    });
  }
  return startGenericFlow({
    providerId: "openai-codex",
    opts,
    needsCodeSubmission: true,
    begin: async () => {
      const flow: CodexFlow = await startCodexLogin();
      const completion = (async () => {
        const creds = await flow.credentials;
        return { creds, codexFlow: flow };
      })();
      return {
        authUrl: flow.authUrl,
        completion,
        submitCode: (code: string) => flow.submitCode(code),
        cancel: () => flow.close(),
      };
    },
  });
}

// Shared orchestration.

interface VendorFlow {
  authUrl: string;
  userCode?: string;
  completion: Promise<{
    creds: {
      access: string;
      refresh: string;
      expires: number;
      idToken?: string;
    };
    codexFlow?: CodexFlow;
  }>;
  submitCode: (code: string) => void;
  cancel: (reason?: string) => void;
}

async function startGenericFlow(args: {
  providerId: SubscriptionProvider;
  opts: StartOptions;
  needsCodeSubmission: boolean;
  begin: () => Promise<VendorFlow>;
}): Promise<OAuthFlowHandle> {
  const { providerId, opts, needsCodeSubmission, begin } = args;
  const sessionId = newSessionId();
  const accountId = resolveAccountId(opts);

  const vendor = await begin();

  const startedAt = Date.now();
  const initialState: FlowState = {
    sessionId,
    providerId,
    status: "pending",
    authUrl: vendor.authUrl,
    needsCodeSubmission,
    ...(opts.replaceAccountId
      ? { replaceAccountId: opts.replaceAccountId }
      : {}),
    startedAt,
  };

  let resolveCompletion!: (value: { account: AccountCredentialRecord }) => void;
  let rejectCompletion!: (err: Error) => void;
  const completion = new Promise<{ account: AccountCredentialRecord }>(
    (resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    },
  );
  // HTTP/SSE callers observe terminal state through the registry and may never
  // await this in-process promise. Attach a rejection observer so timeout or
  // cancellation does not become a process-level unhandled rejection; callers
  // that do await `completion` still receive the original rejection.
  // error-policy:J5 terminal state is observed through the flow registry/SSE;
  // callers awaiting `completion` still receive the original rejection.
  void completion.catch(() => undefined);

  const entry: InternalFlowEntry = {
    state: initialState,
    handle: {} as OAuthFlowHandle, // filled below
    listeners: new Set(),
  };
  flows.set(sessionId, entry);

  const setTerminal = (next: Partial<FlowState> & { status: FlowStatus }) => {
    if (entry.state.status !== "pending") return;
    entry.state = {
      ...entry.state,
      ...next,
      endedAt: Date.now(),
    };
    emit(entry);
    scheduleGc(sessionId);
  };

  const timer = setTimeout(() => {
    const err = new Error("OAuth flow timed out after 5 minutes");
    try {
      vendor.cancel("timeout");
    } catch (cancelErr) {
      logger.debug(
        `[oauth-flow] cancel during timeout failed: ${String(cancelErr)}`,
      );
    }
    setTerminal({ status: "timeout", error: err.message });
    rejectCompletion(err);
  }, FLOW_TIMEOUT_MS);

  // Drive the vendor completion through to account-save and listener emit.
  void (async () => {
    try {
      const { creds } = await vendor.completion;
      clearTimeout(timer);
      let organizationId: string | undefined;
      let email: string | undefined;
      let providerAccountId: string | undefined;
      if (providerId === "anthropic-subscription") {
        const profile = await fetchAnthropicOAuthProfile(creds.access);
        organizationId = profile.organizationId;
        email = profile.email;
        providerAccountId = profile.accountId;
      }
      // Codex bakes the account_id into the JWT — pull it back out for
      // the usage probe header.
      if (providerId === "openai-codex") {
        const codexAccountId = extractCodexAccountId(creds.access);
        if (codexAccountId) organizationId = codexAccountId;
        email = extractJwtEmail(creds.idToken);
      }
      const { record, previous } = buildAccountRecord({
        providerId,
        accountId: providerAccountId ?? accountId,
        ...(opts.replaceAccountId
          ? { replaceAccountId: opts.replaceAccountId }
          : {}),
        label: email ?? opts.label,
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
        ...(creds.idToken ? { idToken: creds.idToken } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
        ...(email ? { email } : {}),
      });
      saveAccount(record);
      try {
        if (opts.onAccountSaved) {
          await opts.onAccountSaved(record);
        }
      } catch (cause) {
        if (previous) {
          saveAccount(previous);
          await opts.onReplacementRollback?.(previous);
        }
        throw new ElizaError("OAuth credential adoption failed", {
          code: "oauth_flow.replacement_adoption_failed",
          severity: "fatal",
          cause,
        });
      }
      // The broadcast state must never carry the tokens — every SSE
      // subscriber receives it verbatim; only the in-process completion
      // promise gets the full record.
      const { credentials: _credentials, ...accountSummary } = record;
      setTerminal({ status: "success", account: accountSummary });
      resolveCompletion({ account: record });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      setTerminal({ status: "error", error: message });
      rejectCompletion(err instanceof Error ? err : new Error(message));
    }
  })();

  let submittedCode: string | null = null;
  const handle: OAuthFlowHandle = {
    sessionId,
    authUrl: vendor.authUrl,
    ...(vendor.userCode ? { userCode: vendor.userCode } : {}),
    needsCodeSubmission,
    completion,
    submitCode: (code: string) => {
      if (submittedCode === code) return;
      if (submittedCode !== null) {
        throw new Error("OAuth callback code was already submitted");
      }
      submittedCode = code;
      vendor.submitCode(code);
    },
    cancel: (reason = "Cancelled") => {
      if (entry.state.status !== "pending") return;
      try {
        vendor.cancel(reason);
      } catch (err) {
        logger.debug(`[oauth-flow] vendor cancel failed: ${String(err)}`);
      }
      clearTimeout(timer);
      const error = new Error(reason);
      setTerminal({ status: "cancelled", error: reason });
      rejectCompletion(error);
    },
  };
  entry.handle = handle;
  emit(entry);

  return handle;
}

// Registry surface used by the SSE / cancel routes.

export function getFlowState(sessionId: string): FlowState | null {
  const entry = flows.get(sessionId);
  return entry ? entry.state : null;
}

export function getFlowHandle(sessionId: string): OAuthFlowHandle | null {
  const entry = flows.get(sessionId);
  return entry ? entry.handle : null;
}

/**
 * Subscribe to status updates for a flow. Replays the current state
 * synchronously so SSE consumers always receive an immediate frame.
 * Returns an unsubscribe function.
 */
export function subscribeFlow(
  sessionId: string,
  listener: (state: FlowState) => void,
): () => void {
  const entry = flows.get(sessionId);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  // Replay current state.
  listener(entry.state);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function cancelFlow(sessionId: string, reason?: string): boolean {
  const entry = flows.get(sessionId);
  if (!entry) return false;
  if (entry.state.status !== "pending") return false;
  entry.handle.cancel(reason);
  return true;
}

export function submitFlowCode(sessionId: string, code: string): boolean {
  const entry = flows.get(sessionId);
  if (!entry) return false;
  if (entry.state.status !== "pending") return false;
  if (!entry.state.needsCodeSubmission) return false;
  try {
    entry.handle.submitCode(code);
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit a callback to the pending flow for a provider when a legacy client
 * does not know the newer account-flow session id. A callback `state` is
 * matched against the authorization URL, so parallel flows cannot consume one
 * another's PKCE code. A state-less raw code is accepted only when exactly one
 * provider flow is pending.
 */
export function submitProviderFlowCode(
  providerId: SubscriptionProvider,
  code: string,
): OAuthFlowHandle | null {
  const callbackState = URL.parse(code)?.searchParams.get("state") ?? null;

  const candidates = [...flows.values()].filter(
    (entry) =>
      entry.state.providerId === providerId &&
      entry.state.status === "pending" &&
      entry.state.needsCodeSubmission,
  );
  const matching = callbackState
    ? candidates.filter(
        (entry) =>
          URL.parse(entry.state.authUrl ?? "")?.searchParams.get("state") ===
          callbackState,
      )
    : candidates;
  if (matching.length !== 1) return null;
  matching[0]?.handle.submitCode(code);
  return matching[0]?.handle ?? null;
}

/**
 * Remove every flow from the registry. Tests use this to reset
 * between cases without resetting the whole module.
 */
export function _resetFlowRegistry(): void {
  for (const entry of flows.values()) {
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
  }
  flows.clear();
}

/**
 * Test-only helper to seed a synthetic flow without going through the
 * vendor layer. Used by `accounts-routes.test.ts` to assert the SSE
 * surface streams `success` / `error` payloads correctly.
 */
export function _registerSyntheticFlow(args: {
  sessionId?: string;
  providerId: SubscriptionProvider;
  authUrl: string;
  needsCodeSubmission?: boolean;
}): { sessionId: string; complete: (state: FlowState) => void } {
  const sessionId = args.sessionId ?? newSessionId();
  const state: FlowState = {
    sessionId,
    providerId: args.providerId,
    status: "pending",
    authUrl: args.authUrl,
    needsCodeSubmission: Boolean(args.needsCodeSubmission),
    startedAt: Date.now(),
  };
  const entry: InternalFlowEntry = {
    state,
    handle: {
      sessionId,
      authUrl: args.authUrl,
      needsCodeSubmission: Boolean(args.needsCodeSubmission),
      completion: new Promise<{ account: AccountCredentialRecord }>(
        () => undefined,
      ),
      submitCode: () => undefined,
      cancel: () => undefined,
    },
    listeners: new Set(),
  };
  flows.set(sessionId, entry);
  const complete = (next: FlowState) => {
    entry.state = { ...next, endedAt: next.endedAt ?? Date.now() };
    emit(entry);
    scheduleGc(sessionId);
  };
  return { sessionId, complete };
}

/** OpenAI Codex JWT carries `chatgpt_account_id` under a vendor claim. */
function extractCodexAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8"),
    ) as Record<string, unknown>;
    const claim = decoded["https://api.openai.com/auth"];
    if (!claim || typeof claim !== "object") return null;
    const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : null;
  } catch {
    return null;
  }
}

function extractJwtEmail(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    ) as Record<string, unknown>;
    return typeof decoded.email === "string" && decoded.email.length > 0
      ? decoded.email
      : undefined;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an imported id_token without
    // a decodable JWT payload has no usable email identity.
    return undefined;
  }
}

export async function fetchAnthropicOAuthProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  email?: string;
  accountId?: string;
  organizationId?: string;
}> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — account linking cannot claim a
    // loaded identity when the authenticated profile request never completed.
    throw new ElizaError("Anthropic OAuth profile request failed", {
      code: "anthropic_oauth.profile_request_failed",
      severity: "ephemeral",
      cause,
    });
  }
  if (!response.ok) {
    throw new ElizaError("Anthropic OAuth profile request was rejected", {
      code: "anthropic_oauth.profile_http_error",
      severity: response.status >= 500 ? "ephemeral" : "fatal",
      context: { status: response.status },
    });
  }

  let profile: unknown;
  try {
    profile = await response.json();
  } catch (cause) {
    // error-policy:J2 context-adding rethrow — malformed authenticated data is
    // a failed profile load, not a valid profile with empty identity fields.
    throw new ElizaError("Anthropic OAuth profile response was not JSON", {
      code: "anthropic_oauth.profile_invalid_json",
      severity: "fatal",
      cause,
    });
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new ElizaError("Anthropic OAuth profile response was invalid", {
      code: "anthropic_oauth.profile_invalid_shape",
      severity: "fatal",
    });
  }
  const record = profile as {
    account?: { uuid?: unknown; email?: unknown; email_address?: unknown };
    organization?: { uuid?: unknown };
  };
  const rawEmail = record.account?.email ?? record.account?.email_address;
  const rawAccountId = record.account?.uuid;
  const rawOrganizationId = record.organization?.uuid;
  return {
    ...(typeof rawEmail === "string" && rawEmail.length > 0
      ? { email: rawEmail }
      : {}),
    ...(typeof rawAccountId === "string" && rawAccountId.length > 0
      ? { accountId: rawAccountId }
      : {}),
    ...(typeof rawOrganizationId === "string" && rawOrganizationId.length > 0
      ? { organizationId: rawOrganizationId }
      : {}),
  };
}
