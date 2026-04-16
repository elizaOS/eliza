import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LifeOpsConnectorSide,
} from "@elizaos/shared/contracts/lifeops";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TelegramAuthState =
  | "idle"
  | "waiting_for_code"
  | "waiting_for_password"
  | "connected"
  | "error";

export interface PendingTelegramAuthSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  phone: string;
  apiId: number;
  apiHash: string;
  state: TelegramAuthState;
  error: string | null;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const pendingTelegramAuthSessions = new Map<
  string,
  PendingTelegramAuthSession
>();

const TELEGRAM_AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Default API credentials
// ---------------------------------------------------------------------------

function resolveApiId(
  explicit?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (explicit !== undefined && explicit > 0) return explicit;
  const envValue = env.ELIZA_TELEGRAM_API_ID;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  // Public test API credentials (https://my.telegram.org)
  return 2040;
}

function resolveApiHash(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit && explicit.length > 0) return explicit;
  const envValue = env.ELIZA_TELEGRAM_API_HASH;
  if (envValue && envValue.length > 0) return envValue;
  // Public test API credentials
  return "b18441a1ff607e10a989891a5462e627";
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function telegramStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveOAuthDir(env), "lifeops", "telegram");
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

function ensureTokenStorageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      pendingTelegramAuthSessions.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

export function startTelegramAuth(args: {
  agentId: string;
  side: LifeOpsConnectorSide;
  phone: string;
  apiId?: number;
  apiHash?: string;
}): PendingTelegramAuthSession {
  cleanupExpiredSessions();

  const sessionId = crypto.randomUUID();
  const apiId = resolveApiId(args.apiId);
  const apiHash = resolveApiHash(args.apiHash);

  const session: PendingTelegramAuthSession = {
    sessionId,
    agentId: args.agentId,
    side: args.side,
    phone: args.phone,
    apiId,
    apiHash,
    state: "idle",
    error: null,
    createdAt: new Date().toISOString(),
  };

  pendingTelegramAuthSessions.set(sessionId, session);

  // TODO: Create a GramJS TelegramClient with StringSession and invoke
  // client.start() to send the auth code to the phone number. The flow:
  //   1. Create `new TelegramClient(new StringSession(""), apiId, apiHash)`.
  //   2. Call `client.connect()`.
  //   3. Call `client.sendCode({ apiId, apiHash }, phone)` to trigger SMS/call.
  //   4. On success: transition state to "waiting_for_code".
  //   5. Store the client reference keyed by sessionId for code submission.
  //   6. On failure: set state to "error" with message.
  //
  // For now, transition to "waiting_for_code" so the auth skeleton is
  // exercisable end-to-end.
  session.state = "waiting_for_code";

  return session;
}

export function submitTelegramAuthCode(
  sessionId: string,
  code: string,
): PendingTelegramAuthSession {
  cleanupExpiredSessions();

  const session = pendingTelegramAuthSessions.get(sessionId);
  if (!session) {
    return {
      sessionId,
      agentId: "",
      side: "owner",
      phone: "",
      apiId: 0,
      apiHash: "",
      state: "error",
      error: "Auth session not found or expired",
      createdAt: new Date().toISOString(),
    };
  }

  if (session.state !== "waiting_for_code") {
    session.state = "error";
    session.error = `Cannot submit code in state "${session.state}"`;
    return session;
  }

  // TODO: Use the stored GramJS client to submit the verification code:
  //   1. Call `client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode }))`.
  //   2. If the response requires 2FA password: transition to "waiting_for_password".
  //   3. On success: extract user info, save session string, transition to "connected".
  //   4. On failure: set state to "error" with message.
  //
  // Placeholder: transition to "connected" and persist a skeleton token.
  session.state = "connected";

  const now = new Date().toISOString();
  const token: StoredTelegramConnectorToken = {
    provider: "telegram",
    agentId: session.agentId,
    side: session.side,
    sessionString: "",
    apiId: session.apiId,
    apiHash: session.apiHash,
    phone: session.phone,
    identity: {
      id: "",
      username: "",
      firstName: "",
    },
    createdAt: now,
    updatedAt: now,
  };

  const tokenRef = buildTelegramTokenRef(session.agentId, session.side);
  const tokenPath = resolveTokenPath(tokenRef);
  ensureTokenStorageDir(path.dirname(tokenPath));
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), {
    mode: 0o600,
  });

  return session;
}

export function submitTelegramAuthPassword(
  sessionId: string,
  password: string,
): PendingTelegramAuthSession {
  cleanupExpiredSessions();

  const session = pendingTelegramAuthSessions.get(sessionId);
  if (!session) {
    return {
      sessionId,
      agentId: "",
      side: "owner",
      phone: "",
      apiId: 0,
      apiHash: "",
      state: "error",
      error: "Auth session not found or expired",
      createdAt: new Date().toISOString(),
    };
  }

  if (session.state !== "waiting_for_password") {
    session.state = "error";
    session.error = `Cannot submit password in state "${session.state}"`;
    return session;
  }

  // TODO: Use the stored GramJS client to submit the 2FA password:
  //   1. Call `client.invoke(new Api.auth.CheckPassword({ password }))`.
  //   2. On success: extract user info, save session string, transition to "connected".
  //   3. On failure: set state to "error" with message.
  //
  // Placeholder: transition to "connected".
  session.state = "connected";

  const now = new Date().toISOString();
  const token: StoredTelegramConnectorToken = {
    provider: "telegram",
    agentId: session.agentId,
    side: session.side,
    sessionString: "",
    apiId: session.apiId,
    apiHash: session.apiHash,
    phone: session.phone,
    identity: {
      id: "",
      username: "",
      firstName: "",
    },
    createdAt: now,
    updatedAt: now,
  };

  const tokenRef = buildTelegramTokenRef(session.agentId, session.side);
  const tokenPath = resolveTokenPath(tokenRef);
  ensureTokenStorageDir(path.dirname(tokenPath));
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), {
    mode: 0o600,
  });

  return session;
}

export function getTelegramAuthStatus(
  sessionId: string,
): PendingTelegramAuthSession | null {
  cleanupExpiredSessions();
  return pendingTelegramAuthSessions.get(sessionId) ?? null;
}

export function cancelTelegramAuth(sessionId: string): void {
  pendingTelegramAuthSessions.delete(sessionId);
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
      return session;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

export function readStoredTelegramToken(
  tokenRef: string,
): StoredTelegramConnectorToken | null {
  const filePath = resolveTokenPath(tokenRef);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<StoredTelegramConnectorToken>;
  if (!parsed || typeof parsed !== "object" || parsed.provider !== "telegram") {
    return null;
  }
  return parsed as StoredTelegramConnectorToken;
}

export function deleteStoredTelegramToken(tokenRef: string): void {
  const filePath = resolveTokenPath(tokenRef);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
