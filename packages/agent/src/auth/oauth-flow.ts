/**
 * OAuth flow orchestration registry.
 *
 * Wraps the provider-specific programmatic OAuth helpers
 * (`startAnthropicOAuthFlowRaw` from
 * `vendor/pi-oauth/anthropic-login.ts` and the loopback-listener flow
 * in `openai-codex.ts`) with:
 *
 *   - a 5-minute timeout per flow,
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
import { logger } from "@elizaos/core";
import {
  type AccountCredentialRecord,
  saveAccount,
} from "./account-storage.ts";
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

export interface FlowState {
  sessionId: string;
  providerId: SubscriptionProvider;
  status: FlowStatus;
  /** Set on `pending` (so the UI can re-open the browser) and on `success`. */
  authUrl?: string;
  /** Anthropic only — the user must paste `code#state`; Codex uses the loopback callback. */
  needsCodeSubmission: boolean;
  account?: AccountCredentialRecord;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface OAuthFlowHandle {
  sessionId: string;
  authUrl: string;
  /** Codex flows resolve via the loopback listener; Anthropic requires `submitCode`. */
  needsCodeSubmission: boolean;
  /** Resolves with the saved AccountCredentialRecord; rejects on cancel/timeout/error. */
  completion: Promise<{ account: AccountCredentialRecord }>;
  /** Anthropic only — submit `code#state` from the redirect page. No-op for Codex. */
  submitCode: (code: string) => void;
  cancel: (reason?: string) => void;
}

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
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

/**
 * Build an `AccountCredentialRecord` and persist it via `saveAccount`.
 * Returns the canonical record (with `createdAt`/`updatedAt` filled).
 */
function persistAccount(args: {
  providerId: SubscriptionProvider;
  accountId: string;
  label: string;
  access: string;
  refresh: string;
  expires: number;
  organizationId?: string;
  email?: string;
}): AccountCredentialRecord {
  const now = Date.now();
  const record: AccountCredentialRecord = {
    id: args.accountId,
    providerId: args.providerId,
    label: args.label,
    source: "oauth",
    credentials: {
      access: args.access,
      refresh: args.refresh,
      expires: args.expires,
    },
    createdAt: now,
    updatedAt: now,
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    ...(args.email ? { email: args.email } : {}),
  };
  saveAccount(record);
  return record;
}

interface StartOptions {
  label: string;
  accountId?: string;
  /**
   * Called after the account is saved on disk. Used by the HTTP
   * route layer to also write a `LinkedAccountConfig` row into
   * `eliza.json`. Failures here propagate as flow `error`.
   */
  onAccountSaved?: (account: AccountCredentialRecord) => void | Promise<void>;
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
 * Start a programmatic Codex OAuth flow. Codex has a loopback listener
 * on :1455, so the user just signs in in the browser and the listener
 * picks up the redirect — `submitCode()` is a no-op. The accountId
 * baked into the JWT is preserved on `LinkedAccountConfig.organizationId`
 * (used by the Codex usage probe via the `ChatGPT-Account-Id` header).
 */
export function startCodexOAuthFlow(
  opts: StartOptions,
): Promise<OAuthFlowHandle> {
  return startGenericFlow({
    providerId: "openai-codex",
    opts,
    needsCodeSubmission: false,
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
  completion: Promise<{
    creds: { access: string; refresh: string; expires: number };
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
      // Codex bakes the account_id into the JWT — pull it back out for
      // the usage probe header.
      if (providerId === "openai-codex") {
        const codexAccountId = extractCodexAccountId(creds.access);
        if (codexAccountId) organizationId = codexAccountId;
      }
      const record = persistAccount({
        providerId,
        accountId,
        label: opts.label,
        access: creds.access,
        refresh: creds.refresh,
        expires: creds.expires,
        ...(organizationId ? { organizationId } : {}),
      });
      if (opts.onAccountSaved) {
        await opts.onAccountSaved(record);
      }
      setTerminal({ status: "success", account: record });
      resolveCompletion({ account: record });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      setTerminal({ status: "error", error: message });
      rejectCompletion(err instanceof Error ? err : new Error(message));
    }
  })();

  const handle: OAuthFlowHandle = {
    sessionId,
    authUrl: vendor.authUrl,
    needsCodeSubmission,
    completion,
    submitCode: (code: string) => {
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
  entry.handle.submitCode(code);
  return true;
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
