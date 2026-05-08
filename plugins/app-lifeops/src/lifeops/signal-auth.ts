// Deprecated LifeOps fallback shim. Active LifeOps Signal mixins no longer
// import this file; Signal pairing should live in @elizaos/plugin-signal.
// This remains only for legacy owner-device cleanup/tests until setup routes
// are fully delegated.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import {
  type SignalPairingEvent,
  SignalPairingSession,
  type SignalPairingSnapshot,
} from "@elizaos/agent/services/signal-pairing";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalPairingStatus,
} from "@elizaos/shared";

export interface PendingSignalPairingSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  authDir: string;
  state: LifeOpsSignalPairingStatus["state"];
  qrDataUrl: string | null;
  error: string | null;
  phoneNumber: string | null;
  uuid: string | null;
  createdAt: string;
}

export interface SignalLinkedDeviceInfo {
  authDir: string;
  phoneNumber: string;
  uuid: string;
  deviceName: string;
}

export interface SignalLinkedDeviceCandidate {
  agentId: string;
  side: LifeOpsConnectorSide;
  tokenRef: string;
  info: SignalLinkedDeviceInfo;
}

interface StoredPendingSignalPairingSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  authDir: string;
  createdAt: string;
}

interface ManagedSignalPairingSession extends PendingSignalPairingSession {
  pairingSession: SignalPairingSession;
}

const pendingSignalPairingSessions = new Map<
  string,
  ManagedSignalPairingSession
>();
const SIGNAL_PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;

function signalStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "signal");
}

function signalPendingSessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(signalStorageRoot(env), "pending");
}

function signalAuthDir(
  agentId: string,
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(signalStorageRoot(env), agentId, side);
}

function credentialFilePath(authDir: string): string {
  return path.join(authDir, "device-info.json");
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function pendingSignalSessionPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    signalPendingSessionDir(env),
    `${sanitizePathSegment(sessionId)}.json`,
  );
}

function writePendingSignalSession(
  session: PendingSignalPairingSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  fs.mkdirSync(signalPendingSessionDir(env), { recursive: true });
  const stored: StoredPendingSignalPairingSession = {
    sessionId: session.sessionId,
    agentId: session.agentId,
    side: session.side,
    authDir: session.authDir,
    createdAt: session.createdAt,
  };
  fs.writeFileSync(
    pendingSignalSessionPath(session.sessionId, env),
    JSON.stringify(stored, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
}

function readPendingSignalSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredPendingSignalPairingSession | null {
  const filePath = pendingSignalSessionPath(sessionId, env);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    ) as StoredPendingSignalPairingSession;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.sessionId === sessionId &&
      typeof parsed.agentId === "string" &&
      (parsed.side === "owner" || parsed.side === "agent") &&
      typeof parsed.authDir === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed;
    }
  } catch {
    // Invalid files are discarded below.
  }
  fs.rmSync(filePath, { force: true });
  return null;
}

function listPendingSignalSessions(
  env: NodeJS.ProcessEnv = process.env,
): StoredPendingSignalPairingSession[] {
  const dir = signalPendingSessionDir(env);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const sessions: StoredPendingSignalPairingSession[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const sessionId = entry.replace(/\.json$/i, "");
    const session = readPendingSignalSession(sessionId, env);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}

function deletePendingSignalSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  fs.rmSync(pendingSignalSessionPath(sessionId, env), { force: true });
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of pendingSignalPairingSessions) {
    if (
      now - new Date(session.createdAt).getTime() >
      SIGNAL_PAIRING_SESSION_TTL_MS
    ) {
      session.pairingSession.stop();
      pendingSignalPairingSessions.delete(sessionId);
      deletePendingSignalSession(sessionId);
    }
  }
  for (const session of listPendingSignalSessions()) {
    if (
      now - new Date(session.createdAt).getTime() >
      SIGNAL_PAIRING_SESSION_TTL_MS
    ) {
      deletePendingSignalSession(session.sessionId);
    }
  }
}

function clearPendingSignalSessionsForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
): void {
  for (const [sessionId, session] of pendingSignalPairingSessions) {
    if (session.agentId === agentId && session.side === side) {
      session.pairingSession.stop();
      pendingSignalPairingSessions.delete(sessionId);
      deletePendingSignalSession(sessionId);
    }
  }
  for (const session of listPendingSignalSessions()) {
    if (session.agentId === agentId && session.side === side) {
      deletePendingSignalSession(session.sessionId);
    }
  }
}

function createManagedSignalSession(args: {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  authDir: string;
  createdAt: string;
}): ManagedSignalPairingSession {
  let managedSession!: ManagedSignalPairingSession;
  managedSession = {
    sessionId: args.sessionId,
    agentId: args.agentId,
    side: args.side,
    authDir: args.authDir,
    state: "generating_qr",
    qrDataUrl: null,
    error: null,
    phoneNumber: null,
    uuid: null,
    createdAt: args.createdAt,
    pairingSession: new SignalPairingSession({
      authDir: args.authDir,
      accountId: `${args.agentId}:${args.side}`,
      onEvent: (event) => {
        applyEvent(managedSession, event);
      },
    }),
  };
  return managedSession;
}

function restorePendingSignalPairingSession(
  stored: StoredPendingSignalPairingSession,
): ManagedSignalPairingSession {
  const managedSession = createManagedSignalSession(stored);
  pendingSignalPairingSessions.set(managedSession.sessionId, managedSession);
  void managedSession.pairingSession.start().catch((error) => {
    managedSession.state = "failed";
    managedSession.error =
      error instanceof Error ? error.message : String(error);
    managedSession.qrDataUrl = null;
  });
  return managedSession;
}

function sessionForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
): ManagedSignalPairingSession | null {
  cleanupExpiredSessions();
  for (const session of pendingSignalPairingSessions.values()) {
    if (session.agentId === agentId && session.side === side) {
      return session;
    }
  }
  const stored = listPendingSignalSessions().find(
    (session) => session.agentId === agentId && session.side === side,
  );
  return stored ? restorePendingSignalPairingSession(stored) : null;
}

function toLifeOpsPairingState(
  snapshot: SignalPairingSnapshot,
): LifeOpsSignalPairingStatus["state"] {
  switch (snapshot.status) {
    case "initializing":
      return "generating_qr";
    case "waiting_for_qr":
      return "waiting_for_scan";
    case "connected":
      return "connected";
    case "idle":
    case "disconnected":
      return "idle";
    case "timeout":
    case "error":
      return "failed";
    default:
      return "failed";
  }
}

function toPairingStatus(
  session: PendingSignalPairingSession,
): LifeOpsSignalPairingStatus {
  return {
    sessionId: session.sessionId,
    state: session.state,
    qrDataUrl: session.qrDataUrl,
    error: session.error,
  };
}

function writeDeviceInfo(session: ManagedSignalPairingSession): void {
  if (!session.phoneNumber) {
    return;
  }
  const info: SignalLinkedDeviceInfo = {
    authDir: session.authDir,
    phoneNumber: session.phoneNumber,
    uuid: session.uuid ?? "",
    deviceName: "Eliza Mac",
  };
  fs.mkdirSync(session.authDir, { recursive: true });
  fs.writeFileSync(
    credentialFilePath(session.authDir),
    JSON.stringify(info, null, 2),
    {
      encoding: "utf-8",
      mode: 0o600,
    },
  );
}

function applySnapshot(
  session: ManagedSignalPairingSession,
  snapshot: SignalPairingSnapshot,
): void {
  session.state = toLifeOpsPairingState(snapshot);
  session.qrDataUrl = snapshot.qrDataUrl;
  session.error = snapshot.error;
}

function applyEvent(
  session: ManagedSignalPairingSession,
  event: SignalPairingEvent,
): void {
  const snapshot = session.pairingSession.getSnapshot();
  applySnapshot(session, snapshot);

  if (
    typeof event.phoneNumber === "string" &&
    event.phoneNumber.trim().length > 0
  ) {
    session.phoneNumber = event.phoneNumber.trim();
  }
  if (typeof event.uuid === "string" && event.uuid.trim().length > 0) {
    session.uuid = event.uuid.trim();
  }

  if (event.type === "signal-qr" && event.qrDataUrl) {
    session.qrDataUrl = event.qrDataUrl;
    session.state = "waiting_for_scan";
    session.error = null;
  }

  if (event.type === "signal-status" && event.error) {
    session.error = event.error;
  }

  if (session.state === "connected") {
    writeDeviceInfo(session);
    deletePendingSignalSession(session.sessionId);
  }
}

export function startSignalPairing(
  agentId: string,
  side: LifeOpsConnectorSide,
): PendingSignalPairingSession {
  cleanupExpiredSessions();
  clearPendingSignalSessionsForSide(agentId, side);

  const sessionId = crypto.randomUUID();
  const authDir = signalAuthDir(agentId, side);

  fs.mkdirSync(authDir, { recursive: true });

  const managedSession = createManagedSignalSession({
    sessionId,
    agentId,
    side,
    authDir,
    createdAt: new Date().toISOString(),
  });

  pendingSignalPairingSessions.set(sessionId, managedSession);
  writePendingSignalSession(managedSession);

  void managedSession.pairingSession.start().catch((error) => {
    managedSession.state = "failed";
    managedSession.error =
      error instanceof Error ? error.message : String(error);
    managedSession.qrDataUrl = null;
  });

  return managedSession;
}

export function getSignalPairingStatus(
  sessionId: string,
): LifeOpsSignalPairingStatus {
  cleanupExpiredSessions();

  const session =
    pendingSignalPairingSessions.get(sessionId) ??
    (() => {
      const stored = readPendingSignalSession(sessionId);
      return stored ? restorePendingSignalPairingSession(stored) : null;
    })();
  if (!session) {
    return {
      sessionId,
      state: "failed",
      qrDataUrl: null,
      error: "Pairing session not found or expired",
    };
  }

  applySnapshot(session, session.pairingSession.getSnapshot());
  return toPairingStatus(session);
}

export function getSignalPairingStatusForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
): LifeOpsSignalPairingStatus | null {
  const session = sessionForSide(agentId, side);
  if (!session) {
    return null;
  }
  applySnapshot(session, session.pairingSession.getSnapshot());
  return toPairingStatus(session);
}

export function stopSignalPairing(
  agentId: string,
  side: LifeOpsConnectorSide,
): { readonly stopped: boolean; readonly sessionId: string | null } {
  const session = sessionForSide(agentId, side);
  if (!session) {
    return { stopped: false, sessionId: null };
  }
  const sessionId = session.sessionId;
  session.pairingSession.stop();
  pendingSignalPairingSessions.delete(sessionId);
  deletePendingSignalSession(sessionId);
  return { stopped: true, sessionId };
}

export function readSignalLinkedDeviceInfo(
  tokenRef: string,
): SignalLinkedDeviceInfo | null {
  const filePath = credentialFilePath(tokenRef);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  let parsed: Partial<SignalLinkedDeviceInfo>;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (
    typeof parsed.authDir !== "string" ||
    parsed.authDir.trim().length === 0 ||
    typeof parsed.phoneNumber !== "string" ||
    parsed.phoneNumber.trim().length === 0
  ) {
    return null;
  }
  return {
    authDir: parsed.authDir,
    phoneNumber: parsed.phoneNumber.trim(),
    uuid: typeof parsed.uuid === "string" ? parsed.uuid : "",
    deviceName:
      typeof parsed.deviceName === "string" &&
      parsed.deviceName.trim().length > 0
        ? parsed.deviceName
        : "Eliza Mac",
  };
}

function linkedDeviceCandidate(
  agentId: string,
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): SignalLinkedDeviceCandidate | null {
  const tokenRef = signalAuthDir(agentId, side, env);
  const info = readSignalLinkedDeviceInfo(tokenRef);
  return info
    ? {
        agentId,
        side,
        tokenRef,
        info,
      }
    : null;
}

function listLinkedDeviceCandidatesForSide(
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): SignalLinkedDeviceCandidate[] {
  const root = signalStorageRoot(env);
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "pending")
    .flatMap((entry) => {
      const candidate = linkedDeviceCandidate(entry.name, side, env);
      return candidate ? [candidate] : [];
    });
}

export function findSignalLinkedDeviceInfoForSide(
  agentId: string,
  side: LifeOpsConnectorSide,
  env: NodeJS.ProcessEnv = process.env,
): SignalLinkedDeviceCandidate | null {
  const exact = linkedDeviceCandidate(agentId, side, env);
  if (exact) {
    return exact;
  }

  const candidates = listLinkedDeviceCandidatesForSide(side, env).filter(
    (candidate) => candidate.agentId !== agentId,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function deleteSignalLinkedDevice(tokenRef: string): void {
  if (fs.existsSync(tokenRef)) {
    fs.rmSync(tokenRef, { recursive: true, force: true });
  }
}
