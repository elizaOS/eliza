// Deprecated LifeOps fallback shim. Active LifeOps Telegram mixins no longer
// import this file; Telegram account auth is implemented by
// @elizaos/plugin-telegram. This remains only for legacy storage cleanup/tests
// until the plugin-side setup surface fully replaces LifeOps routes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import { logger } from "@elizaos/core";
// Re-export the real GramJS auth session from plugin-telegram.
// The plugin's TelegramAccountAuthSession handles the full MTProto flow:
//   provisioning → code → 2FA → session persistence.
// LifeOps wraps it with its own session management and token storage.
import {
  TelegramAccountAuthSession,
  type TelegramAccountAuthSessionLike,
  type TelegramAccountAuthSnapshot,
  type TelegramAccountConnectorConfig,
} from "@elizaos/plugin-telegram/account-auth-service";
import type { LifeOpsConnectorSide } from "@elizaos/shared";
import {
  decryptTokenEnvelope,
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
  resolveTokenEncryptionKey,
} from "./token-encryption.js";

export type { TelegramAccountAuthSnapshot, TelegramAccountConnectorConfig };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelegramAuthState =
  | "idle"
  | "waiting_for_provisioning_code"
  | "waiting_for_code"
  | "waiting_for_password"
  | "connected"
  | "error";

export type RetryableTelegramAuthState = Extract<
  TelegramAuthState,
  "waiting_for_provisioning_code" | "waiting_for_code" | "waiting_for_password"
>;

export interface PendingTelegramAuthSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  phone: string;
  apiId: number | null;
  apiHash: string | null;
  state: TelegramAuthState;
  error: string | null;
  identity: {
    id: string;
    username: string;
    firstName: string;
  } | null;
  createdAt: string;
  /** The real GramJS auth session that does the heavy lifting. */
  authSession: TelegramAccountAuthSessionLike;
}

export interface StoredTelegramConnectorToken {
  provider: "telegram";
  agentId: string;
  side: LifeOpsConnectorSide;
  sessionString: string;
  apiId: number;
  apiHash: string;
  phone: string;
  identity: {
    id: string;
    username: string;
    firstName: string;
  };
  connectorConfig: TelegramAccountConnectorConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTelegramConnectorTokenCandidate {
  agentId: string;
  side: LifeOpsConnectorSide;
  tokenRef: string;
  token: StoredTelegramConnectorToken;
}

interface StoredPendingTelegramAuthSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  phone: string;
  apiId: number | null;
  apiHash: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const pendingTelegramAuthSessions = new Map<
  string,
  PendingTelegramAuthSession
>();

const TELEGRAM_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

function stopPendingTelegramAuthSession(
  sessionId: string,
  session: PendingTelegramAuthSession,
): void {
  void session.authSession.stop().catch((error) => {
    logger.warn(
      `[TelegramAuth] failed to stop pending auth session ${sessionId}: ${errorMessage(error)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Default API credentials
// ---------------------------------------------------------------------------

function resolveApiId(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (explicit !== undefined && explicit > 0) return explicit;
  const envValue = env.ELIZA_TELEGRAM_API_ID ?? env.TELEGRAM_ACCOUNT_APP_ID;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Return null to trigger provisioning flow (my.telegram.org).
  return null;
}

function resolveApiHash(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit && explicit.length > 0) return explicit;
  const envValue = env.ELIZA_TELEGRAM_API_HASH ?? env.TELEGRAM_ACCOUNT_APP_HASH;
  if (envValue && envValue.length > 0) return envValue;
  return null;
}

export function hasManagedTelegramCredentials(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    resolveApiId(undefined, env) !== null &&
    resolveApiHash(undefined, env) !== null
  );
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function telegramStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "telegram");
}

function telegramPendingSessionDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(telegramStorageRoot(env), "pending");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildTelegramTokenRef(
  agentId: string,
  side: LifeOpsConnectorSide,
): string {
  return path.join(
    sanitizePathSegment(agentId),
    sanitizePathSegment(side),
    "local.json",
  );
}

function resolveTokenPath(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(telegramStorageRoot(env), tokenRef);
}

function resolvePendingSessionPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    telegramPendingSessionDir(env),
    `${sanitizePathSegment(sessionId)}.json`,
  );
}

function ensureTokenStorageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readTelegramStoragePayload(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const rawFileContents = fs.readFileSync(filePath, "utf-8");
  const parsedRaw = JSON.parse(rawFileContents);
  if (!isEncryptedTokenEnvelope(parsedRaw)) {
    return rawFileContents;
  }
  const key = resolveTokenEncryptionKey(telegramStorageRoot(env), env);
  return decryptTokenEnvelope(parsedRaw, key);
}

function writeTelegramStoragePayload(
  filePath: string,
  payload: StoredPendingTelegramAuthSession | StoredTelegramConnectorToken,
  env: NodeJS.ProcessEnv = process.env,
): void {
  ensureTokenStorageDir(path.dirname(filePath));
  const key = resolveTokenEncryptionKey(telegramStorageRoot(env), env);
  const envelope = encryptTokenPayload(JSON.stringify(payload), key);
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Non-fatal on platforms without chmod semantics.
  }
}

function decodePendingTelegramSession(
  rawJson: string,
  sessionId: string,
): StoredPendingTelegramAuthSession | null {
  const parsed = JSON.parse(rawJson) as StoredPendingTelegramAuthSession;
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.sessionId === sessionId &&
    typeof parsed.agentId === "string" &&
    (parsed.side === "owner" || parsed.side === "agent") &&
    typeof parsed.phone === "string" &&
    typeof parsed.createdAt === "string"
  ) {
    return parsed;
  }
  return null;
}

function writePendingTelegramSession(
  session: PendingTelegramAuthSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const stored: StoredPendingTelegramAuthSession = {
    sessionId: session.sessionId,
    agentId: session.agentId,
    side: session.side,
    phone: session.phone,
    apiId: session.apiId,
    apiHash: session.apiHash,
    createdAt: session.createdAt,
  };
  const filePath = resolvePendingSessionPath(session.sessionId, env);
  writeTelegramStoragePayload(filePath, stored, env);
}

function deletePendingTelegramSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  fs.rmSync(resolvePendingSessionPath(sessionId, env), { force: true });
}

function readPendingTelegramSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredPendingTelegramAuthSession | null {
  const filePath = resolvePendingSessionPath(sessionId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const decoded = decodePendingTelegramSession(
      readTelegramStoragePayload(filePath, env),
      sessionId,
    );
    if (decoded) {
      return decoded;
    }
  } catch {
    // Invalid files are discarded below.
  }
  fs.rmSync(filePath, { force: true });
  return null;
}

function listPendingTelegramSessions(
  env: NodeJS.ProcessEnv = process.env,
): StoredPendingTelegramAuthSession[] {
  const dir = telegramPendingSessionDir(env);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const sessions: StoredPendingTelegramAuthSession[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const sessionId = entry.replace(/\.json$/i, "");
    const session = readPendingTelegramSession(sessionId, env);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of pendingTelegramAuthSessions) {
    if (
      now - new Date(session.createdAt).getTime() >
      TELEGRAM_AUTH_SESSION_TTL_MS
    ) {
      // Stop the GramJS client before evicting.
      stopPendingTelegramAuthSession(sessionId, session);
      pendingTelegramAuthSessions.delete(sessionId);
      deletePendingTelegramSession(sessionId);
    }
  }
  for (const session of listPendingTelegramSessions()) {
    if (
      now - new Date(session.createdAt).getTime() >
      TELEGRAM_AUTH_SESSION_TTL_MS
    ) {
      deletePendingTelegramSession(session.sessionId);
    }
  }
}

function clearPendingSessionsForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
): void {
  for (const [sessionId, session] of pendingTelegramAuthSessions) {
    if (session.agentId === agentId && session.side === side) {
      stopPendingTelegramAuthSession(sessionId, session);
      pendingTelegramAuthSessions.delete(sessionId);
      deletePendingTelegramSession(sessionId);
    }
  }
  for (const session of listPendingTelegramSessions()) {
    if (session.agentId === agentId && session.side === side) {
      deletePendingTelegramSession(session.sessionId);
    }
  }
}

/** Map plugin-telegram's status names to LifeOps auth state names. */
function mapSnapshotStatus(
  snapshot: TelegramAccountAuthSnapshot,
): TelegramAuthState {
  switch (snapshot.status) {
    case "idle":
      return "idle";
    case "waiting_for_provisioning_code":
      return "waiting_for_provisioning_code";
    case "waiting_for_telegram_code":
      return "waiting_for_code";
    case "waiting_for_password":
      return "waiting_for_password";
    case "configured":
    case "connected":
      return "connected";
    case "error":
      return "error";
    default:
      return "error";
  }
}

function pluginStatusForRetryState(
  state: RetryableTelegramAuthState,
): TelegramAccountAuthSnapshot["status"] {
  switch (state) {
    case "waiting_for_provisioning_code":
      return "waiting_for_provisioning_code";
    case "waiting_for_code":
      return "waiting_for_telegram_code";
    case "waiting_for_password":
      return "waiting_for_password";
  }
}

export function inferRetryableTelegramAuthState(args: {
  state: TelegramAuthState;
  error: string | null;
}): RetryableTelegramAuthState | null {
  if (
    args.state === "waiting_for_provisioning_code" ||
    args.state === "waiting_for_code" ||
    args.state === "waiting_for_password"
  ) {
    return args.state;
  }
  if (args.state !== "error") {
    return null;
  }

  const message = (args.error ?? "").trim().toUpperCase();
  if (!message) {
    return null;
  }
  if (
    message.includes("PASSWORD_HASH_INVALID") ||
    message.includes("AUTH.CHECKPASSWORD") ||
    message.includes("TWO-FACTOR PASSWORD")
  ) {
    return "waiting_for_password";
  }
  if (
    message.includes("PHONE_CODE_INVALID") ||
    message.includes("PHONE_CODE_EXPIRED") ||
    message.includes("LOGIN CODE")
  ) {
    return "waiting_for_code";
  }
  if (message.includes("PROVISIONING CODE")) {
    return "waiting_for_provisioning_code";
  }
  return null;
}

function persistRetryableTelegramAuthState(
  session: PendingTelegramAuthSession,
  nextState: RetryableTelegramAuthState,
  error: string | null,
): void {
  session.state = nextState;
  session.error = error;

  const authSessionInternal =
    session.authSession as TelegramAccountAuthSessionLike & {
      snapshot?: TelegramAccountAuthSnapshot;
      persistAuthState?: () => void;
    };
  if (authSessionInternal.snapshot) {
    authSessionInternal.snapshot.status = pluginStatusForRetryState(nextState);
    authSessionInternal.snapshot.error = error;
  }
  authSessionInternal.persistAuthState?.();
}

function recoverRetryableTelegramAuthSession(
  session: PendingTelegramAuthSession,
): PendingTelegramAuthSession {
  const retryableState = inferRetryableTelegramAuthState({
    state: session.state,
    error: session.error,
  });
  if (retryableState && session.state !== retryableState) {
    persistRetryableTelegramAuthState(session, retryableState, session.error);
  }
  return session;
}

function mapSnapshotIdentity(
  snapshot: TelegramAccountAuthSnapshot,
): PendingTelegramAuthSession["identity"] {
  if (!snapshot.account) return null;
  return {
    id: snapshot.account.id,
    username: snapshot.account.username ?? "",
    firstName: snapshot.account.firstName ?? "",
  };
}

function restorePendingTelegramAuthSession(
  stored: StoredPendingTelegramAuthSession,
): PendingTelegramAuthSession | null {
  const authSession = new TelegramAccountAuthSession();
  const snapshot = authSession.getSnapshot();
  const connectorConfig = authSession.getResolvedConnectorConfig();
  const hasRecoverableState =
    snapshot.status !== "idle" ||
    Boolean(snapshot.phone) ||
    Boolean(snapshot.error) ||
    connectorConfig !== null;
  if (!hasRecoverableState) {
    deletePendingTelegramSession(stored.sessionId);
    return null;
  }
  const session: PendingTelegramAuthSession = {
    sessionId: stored.sessionId,
    agentId: stored.agentId,
    side: stored.side,
    phone: snapshot.phone ?? stored.phone,
    apiId: stored.apiId,
    apiHash: stored.apiHash,
    state: mapSnapshotStatus(snapshot),
    error: snapshot.error,
    identity: mapSnapshotIdentity(snapshot),
    createdAt: stored.createdAt,
    authSession,
  };
  pendingTelegramAuthSessions.set(session.sessionId, session);
  return recoverRetryableTelegramAuthSession(session);
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

export async function startTelegramAuth(args: {
  agentId: string;
  side: LifeOpsConnectorSide;
  phone: string;
  apiId?: number;
  apiHash?: string;
}): Promise<PendingTelegramAuthSession> {
  cleanupExpiredSessions();
  clearPendingSessionsForSide(args.agentId, args.side);

  const sessionId = crypto.randomUUID();
  const apiId = resolveApiId(args.apiId);
  const apiHash = resolveApiHash(args.apiHash);

  // Create the real GramJS auth session.
  const authSession = new TelegramAccountAuthSession();

  const session: PendingTelegramAuthSession = {
    sessionId,
    agentId: args.agentId,
    side: args.side,
    phone: args.phone,
    apiId,
    apiHash,
    state: "idle",
    error: null,
    identity: null,
    createdAt: new Date().toISOString(),
    authSession,
  };

  pendingTelegramAuthSessions.set(sessionId, session);
  writePendingTelegramSession(session);

  // Start the real auth flow. If credentials are provided, it goes straight
  // to Telegram code. If not, it starts provisioning via my.telegram.org.
  const credentials = apiId && apiHash ? { apiId, apiHash } : null;

  try {
    const snapshot = await authSession.start({
      phone: args.phone,
      credentials,
    });
    session.state = mapSnapshotStatus(snapshot);
    session.error = snapshot.error;
    session.identity = mapSnapshotIdentity(snapshot);
  } catch (error) {
    session.state = "error";
    session.error = error instanceof Error ? error.message : String(error);
  }

  return session;
}

export async function submitTelegramAuthCode(
  sessionId: string,
  code: string,
): Promise<PendingTelegramAuthSession> {
  cleanupExpiredSessions();

  const session =
    pendingTelegramAuthSessions.get(sessionId) ??
    (() => {
      const stored = readPendingTelegramSession(sessionId);
      return stored ? restorePendingTelegramAuthSession(stored) : null;
    })();
  if (!session) {
    return {
      sessionId,
      agentId: "",
      side: "owner",
      phone: "",
      apiId: null,
      apiHash: null,
      state: "error",
      error: "Auth session not found or expired",
      identity: null,
      createdAt: new Date().toISOString(),
      authSession: new TelegramAccountAuthSession(),
    };
  }

  const retryableState = inferRetryableTelegramAuthState({
    state: session.state,
    error: session.error,
  });
  if (retryableState && retryableState !== "waiting_for_password") {
    persistRetryableTelegramAuthState(session, retryableState, session.error);
  }
  const expectedRetryState =
    session.state === "waiting_for_provisioning_code"
      ? "waiting_for_provisioning_code"
      : "waiting_for_code";

  try {
    // Determine which type of code to submit based on current state.
    const submitInput =
      session.state === "waiting_for_provisioning_code"
        ? { provisioningCode: code }
        : { telegramCode: code };

    const snapshot = await session.authSession.submit(submitInput);
    session.state = mapSnapshotStatus(snapshot);
    session.error = snapshot.error;
    session.identity = mapSnapshotIdentity(snapshot);

    // If connected, persist the token.
    if (session.state === "connected") {
      persistTelegramToken(session);
    }
  } catch (error) {
    persistRetryableTelegramAuthState(
      session,
      expectedRetryState,
      error instanceof Error ? error.message : String(error),
    );
  }

  return session;
}

export async function submitTelegramAuthPassword(
  sessionId: string,
  password: string,
): Promise<PendingTelegramAuthSession> {
  cleanupExpiredSessions();

  const session =
    pendingTelegramAuthSessions.get(sessionId) ??
    (() => {
      const stored = readPendingTelegramSession(sessionId);
      return stored ? restorePendingTelegramAuthSession(stored) : null;
    })();
  if (!session) {
    return {
      sessionId,
      agentId: "",
      side: "owner",
      phone: "",
      apiId: null,
      apiHash: null,
      state: "error",
      error: "Auth session not found or expired",
      identity: null,
      createdAt: new Date().toISOString(),
      authSession: new TelegramAccountAuthSession(),
    };
  }

  const retryableState = inferRetryableTelegramAuthState({
    state: session.state,
    error: session.error,
  });
  if (retryableState === "waiting_for_password") {
    persistRetryableTelegramAuthState(session, retryableState, session.error);
  }

  if (session.state !== "waiting_for_password") {
    session.state = "error";
    session.error = `Cannot submit password in state "${session.state}"`;
    return session;
  }

  try {
    const snapshot = await session.authSession.submit({ password });
    session.state = mapSnapshotStatus(snapshot);
    session.error = snapshot.error;
    session.identity = mapSnapshotIdentity(snapshot);

    if (session.state === "connected") {
      persistTelegramToken(session);
    }
  } catch (error) {
    persistRetryableTelegramAuthState(
      session,
      "waiting_for_password",
      error instanceof Error ? error.message : String(error),
    );
  }

  return session;
}

function persistTelegramToken(session: PendingTelegramAuthSession): void {
  const connectorConfig = session.authSession.getResolvedConnectorConfig();
  const now = new Date().toISOString();

  const token: StoredTelegramConnectorToken = {
    provider: "telegram",
    agentId: session.agentId,
    side: session.side,
    // The session string is persisted by TelegramAccountAuthSession
    // in ~/.eliza/telegram-account/session.txt — we store the path reference.
    sessionString: connectorConfig?.appId ? "persisted" : "",
    apiId: connectorConfig
      ? Number(connectorConfig.appId)
      : (session.apiId ?? 0),
    apiHash: connectorConfig?.appHash ?? session.apiHash ?? "",
    phone: session.phone,
    identity: session.identity ?? { id: "", username: "", firstName: "" },
    connectorConfig,
    createdAt: now,
    updatedAt: now,
  };

  const tokenRef = buildTelegramTokenRef(session.agentId, session.side);
  const tokenPath = resolveTokenPath(tokenRef);
  writeTelegramStoragePayload(tokenPath, token);
}

export function getTelegramAuthStatus(
  sessionId: string,
): PendingTelegramAuthSession | null {
  cleanupExpiredSessions();
  const existing = pendingTelegramAuthSessions.get(sessionId);
  if (existing) {
    return existing;
  }
  const stored = readPendingTelegramSession(sessionId);
  return stored ? restorePendingTelegramAuthSession(stored) : null;
}

export async function cancelTelegramAuth(sessionId: string): Promise<void> {
  const session = pendingTelegramAuthSessions.get(sessionId);
  if (session) {
    try {
      await session.authSession.stop();
    } catch (error) {
      logger.warn(
        `[TelegramAuth] failed to stop canceled auth session ${sessionId}: ${errorMessage(error)}`,
      );
    }
    pendingTelegramAuthSessions.delete(sessionId);
  }
  deletePendingTelegramSession(sessionId);
}

// ---------------------------------------------------------------------------
// Token ref builder (exported for service mixin)
// ---------------------------------------------------------------------------

export { buildTelegramTokenRef };

// ---------------------------------------------------------------------------
// Session lookup
// ---------------------------------------------------------------------------

export function findPendingTelegramAuthSession(
  agentId: string,
  side: LifeOpsConnectorSide,
): PendingTelegramAuthSession | null {
  cleanupExpiredSessions();
  for (const session of pendingTelegramAuthSessions.values()) {
    if (session.agentId === agentId && session.side === side) {
      return recoverRetryableTelegramAuthSession(session);
    }
  }
  const stored = listPendingTelegramSessions().find(
    (session) => session.agentId === agentId && session.side === side,
  );
  return stored ? restorePendingTelegramAuthSession(stored) : null;
}

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

function isStoredTelegramConnectorToken(
  value: unknown,
): value is StoredTelegramConnectorToken {
  if (!value || typeof value !== "object") {
    return false;
  }
  const token = value as Partial<StoredTelegramConnectorToken>;
  return (
    token.provider === "telegram" &&
    typeof token.agentId === "string" &&
    (token.side === "owner" || token.side === "agent") &&
    typeof token.sessionString === "string" &&
    typeof token.apiId === "number" &&
    typeof token.apiHash === "string" &&
    typeof token.phone === "string" &&
    Boolean(token.identity) &&
    typeof token.identity === "object" &&
    typeof token.identity.id === "string" &&
    typeof token.identity.username === "string" &&
    typeof token.identity.firstName === "string" &&
    typeof token.createdAt === "string" &&
    typeof token.updatedAt === "string"
  );
}

export function readStoredTelegramToken(
  tokenRef: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredTelegramConnectorToken | null {
  const filePath = resolveTokenPath(tokenRef, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let parsed: Partial<StoredTelegramConnectorToken>;
  try {
    parsed = JSON.parse(readTelegramStoragePayload(filePath, env));
  } catch {
    return null;
  }
  if (!isStoredTelegramConnectorToken(parsed)) {
    return null;
  }
  return parsed;
}

function storedTelegramTokenCandidate(
  agentId: string,
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): StoredTelegramConnectorTokenCandidate | null {
  const tokenRef = buildTelegramTokenRef(agentId, side);
  const token = readStoredTelegramToken(tokenRef, env);
  return token
    ? {
        agentId,
        side,
        tokenRef,
        token,
      }
    : null;
}

function listStoredTelegramTokenCandidatesForSide(
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): StoredTelegramConnectorTokenCandidate[] {
  const root = telegramStorageRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "pending")
    .flatMap((entry) => {
      const candidate = storedTelegramTokenCandidate(entry.name, side, env);
      return candidate ? [candidate] : [];
    });
}

export function findStoredTelegramTokenForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): StoredTelegramConnectorTokenCandidate | null {
  const exact = storedTelegramTokenCandidate(agentId, side, env);
  if (exact) {
    return exact;
  }

  const candidates = listStoredTelegramTokenCandidatesForSide(side, env).filter(
    (candidate) => candidate.agentId !== agentId,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function deleteStoredTelegramToken(tokenRef: string): void {
  const filePath = resolveTokenPath(tokenRef);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
