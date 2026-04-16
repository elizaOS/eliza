import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  LifeOpsConnectorSide,
  LifeOpsSignalPairingStatus,
} from "@elizaos/shared/contracts/lifeops";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingSignalPairingSession {
  sessionId: string;
  agentId: string;
  side: LifeOpsConnectorSide;
  authDir: string;
  state: LifeOpsSignalPairingStatus["state"];
  qrDataUrl: string | null;
  error: string | null;
  createdAt: string;
}

export interface SignalLinkedDeviceInfo {
  authDir: string;
  phoneNumber: string;
  uuid: string;
  deviceName: string;
}

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const pendingSignalPairingSessions = new Map<
  string,
  PendingSignalPairingSession
>();

const SIGNAL_PAIRING_SESSION_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signalStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
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
      pendingSignalPairingSessions.delete(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// Pairing lifecycle
// ---------------------------------------------------------------------------

export function startSignalPairing(
  agentId: string,
  side: LifeOpsConnectorSide,
): PendingSignalPairingSession {
  cleanupExpiredSessions();

  const sessionId = crypto.randomUUID();
  const authDir = signalAuthDir(agentId, side);

  fs.mkdirSync(authDir, { recursive: true });

  const session: PendingSignalPairingSession = {
    sessionId,
    agentId,
    side,
    authDir,
    state: "generating_qr",
    qrDataUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
  };

  pendingSignalPairingSessions.set(sessionId, session);

  // TODO: Spawn the actual Signal linked-device pairing process.
  //
  // Check for @nicovlabs/signal-native availability first; fall back to
  // signal-cli binary if present. The pairing flow should:
  //   1. Generate a provisioning URL and encode it as a QR data URL.
  //   2. Update `session.state` to "waiting_for_scan" and set `qrDataUrl`.
  //   3. Wait for the user to scan the QR code on their phone.
  //   4. Transition to "linking" while the device registration completes.
  //   5. On success: write device-info.json, set state to "connected".
  //   6. On failure: set state to "failed" with an error message.
  //
  // For now, transition to "waiting_for_scan" with a placeholder so that
  // the auth flow skeleton and grant management are exercisable.
  session.state = "waiting_for_scan";

  return session;
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

  return {
    sessionId: session.sessionId,
    state: session.state,
    qrDataUrl: session.qrDataUrl,
    error: session.error,
  };
}

export function cancelSignalPairing(sessionId: string): void {
  const session = pendingSignalPairingSessions.get(sessionId);
  if (session) {
    pendingSignalPairingSessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

export function readSignalLinkedDeviceInfo(
  tokenRef: string,
): SignalLinkedDeviceInfo | null {
  const filePath = credentialFilePath(tokenRef);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as SignalLinkedDeviceInfo;
  if (!parsed.authDir || !parsed.phoneNumber || !parsed.uuid) {
    return null;
  }
  return parsed;
}

export function deleteSignalLinkedDevice(tokenRef: string): void {
  if (fs.existsSync(tokenRef)) {
    fs.rmSync(tokenRef, { recursive: true, force: true });
  }
}
