import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalPairingStatus,
} from "@elizaos/shared/contracts/lifeops";
import {
  SignalPairingSession,
  type SignalPairingEvent,
  type SignalPairingSnapshot,
} from "@elizaos/agent/services/signal-pairing";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";

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

interface ManagedSignalPairingSession extends PendingSignalPairingSession {
  pairingSession: SignalPairingSession;
}

const pendingSignalPairingSessions = new Map<string, ManagedSignalPairingSession>();
const SIGNAL_PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;

function signalStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOAuthDir(env), "lifeops", "signal");
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

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of pendingSignalPairingSessions) {
    if (
      now - new Date(session.createdAt).getTime() >
      SIGNAL_PAIRING_SESSION_TTL_MS
    ) {
      session.pairingSession.stop();
      pendingSignalPairingSessions.delete(sessionId);
    }
  }
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
  return null;
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
  fs.writeFileSync(credentialFilePath(session.authDir), JSON.stringify(info, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
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

  if (typeof event.phoneNumber === "string" && event.phoneNumber.trim().length > 0) {
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
  }
}

export function startSignalPairing(
  agentId: string,
  side: LifeOpsConnectorSide,
): PendingSignalPairingSession {
  cleanupExpiredSessions();

  const existing = sessionForSide(agentId, side);
  if (existing) {
    existing.pairingSession.stop();
    pendingSignalPairingSessions.delete(existing.sessionId);
  }

  const sessionId = crypto.randomUUID();
  const authDir = signalAuthDir(agentId, side);

  fs.mkdirSync(authDir, { recursive: true });

  const managedSession: ManagedSignalPairingSession = {
    sessionId,
    agentId,
    side,
    authDir,
    state: "generating_qr",
    qrDataUrl: null,
    error: null,
    phoneNumber: null,
    uuid: null,
    createdAt: new Date().toISOString(),
    pairingSession: new SignalPairingSession({
      authDir,
      accountId: `${agentId}:${side}`,
      onEvent: (event) => {
        applyEvent(managedSession, event);
      },
    }),
  };

  pendingSignalPairingSessions.set(sessionId, managedSession);

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

  const session = pendingSignalPairingSessions.get(sessionId);
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
): void {
  const session = sessionForSide(agentId, side);
  if (!session) {
    return;
  }
  session.pairingSession.stop();
  pendingSignalPairingSessions.delete(session.sessionId);
}

export function readSignalLinkedDeviceInfo(
  tokenRef: string,
): SignalLinkedDeviceInfo | null {
  const filePath = credentialFilePath(tokenRef);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as SignalLinkedDeviceInfo;
  if (!parsed.authDir || !parsed.phoneNumber) {
    return null;
  }
  return {
    authDir: parsed.authDir,
    phoneNumber: parsed.phoneNumber,
    uuid: parsed.uuid ?? "",
    deviceName: parsed.deviceName ?? "Eliza Mac",
  };
}

export function deleteSignalLinkedDevice(tokenRef: string): void {
  if (fs.existsSync(tokenRef)) {
    fs.rmSync(tokenRef, { recursive: true, force: true });
  }
}
