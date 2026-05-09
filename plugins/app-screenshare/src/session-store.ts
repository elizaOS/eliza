import { randomBytes, randomUUID } from "node:crypto";
import {
  type DesktopControlCapabilities,
  detectDesktopControlCapabilities,
  getDesktopPlatformName,
} from "@elizaos/plugin-computeruse";
import type { AppSessionState } from "@elizaos/shared/contracts/apps";

export const SCREENSHARE_APP_NAME = "@elizaos/app-screenshare";
export const SCREENSHARE_DISPLAY_NAME = "Screen Share";

export type ScreenshareSessionStatus = "active" | "stopped";

export interface ScreenshareSession {
  id: string;
  token: string;
  label: string;
  status: ScreenshareSessionStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  platform: NodeJS.Platform;
  frameCount: number;
  inputCount: number;
  lastFrameAt: string | null;
  lastInputAt: string | null;
}

export interface ScreensharePublicSession {
  id: string;
  label: string;
  status: ScreenshareSessionStatus;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  platform: NodeJS.Platform;
  frameCount: number;
  inputCount: number;
  lastFrameAt: string | null;
  lastInputAt: string | null;
}

interface ScreenshareSessionStore {
  sessions: Map<string, ScreenshareSession>;
  localSessionId: string | null;
}

const STORE_KEY = Symbol.for("elizaos.app-screenshare.session-store");

function getStore(): ScreenshareSessionStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const existing = globalObject[STORE_KEY] as
    | ScreenshareSessionStore
    | undefined;
  if (existing) {
    return existing;
  }

  const created: ScreenshareSessionStore = {
    sessions: new Map<string, ScreenshareSession>(),
    localSessionId: null,
  };
  globalObject[STORE_KEY] = created;
  return created;
}

export function createScreenshareSession(
  label = "This machine",
): ScreenshareSession {
  const now = new Date().toISOString();
  const store = getStore();
  if (store.localSessionId) {
    stopSessionInStore(store, store.localSessionId, now);
  }
  const session: ScreenshareSession = {
    id: randomUUID(),
    token: randomBytes(24).toString("base64url"),
    label,
    status: "active",
    createdAt: now,
    updatedAt: now,
    stoppedAt: null,
    platform: getDesktopPlatformName(),
    frameCount: 0,
    inputCount: 0,
    lastFrameAt: null,
    lastInputAt: null,
  };

  store.sessions.set(session.id, session);
  store.localSessionId = session.id;
  return session;
}

export function getOrCreateLocalScreenshareSession(): ScreenshareSession {
  const store = getStore();
  const localId = store.localSessionId;
  if (localId) {
    const existing = store.sessions.get(localId);
    if (existing?.status === "active") {
      return existing;
    }
  }
  return createScreenshareSession();
}

export function getScreenshareSession(
  sessionId: string,
): ScreenshareSession | null {
  return getStore().sessions.get(sessionId) ?? null;
}

export function listScreenshareSessions(): ScreensharePublicSession[] {
  return Array.from(getStore().sessions.values())
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(toPublicSession);
}

export function stopScreenshareSession(
  sessionId: string,
): ScreenshareSession | null {
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (!session) {
    return null;
  }
  if (session.status === "stopped") {
    return session;
  }
  const now = new Date().toISOString();
  return stopSessionInStore(store, sessionId, now);
}

function stopSessionInStore(
  store: ScreenshareSessionStore,
  sessionId: string,
  stoppedAt: string,
): ScreenshareSession | null {
  const session = store.sessions.get(sessionId);
  if (!session) {
    return null;
  }
  if (session.status === "stopped") {
    return session;
  }
  const stopped: ScreenshareSession = {
    ...session,
    status: "stopped",
    updatedAt: stoppedAt,
    stoppedAt,
  };
  store.sessions.set(sessionId, stopped);
  if (store.localSessionId === sessionId) {
    store.localSessionId = null;
  }
  return stopped;
}

export function recordScreenshareFrame(
  sessionId: string,
): ScreenshareSession | null {
  const session = getStore().sessions.get(sessionId);
  if (!session) {
    return null;
  }
  const now = new Date().toISOString();
  const updated: ScreenshareSession = {
    ...session,
    frameCount: session.frameCount + 1,
    lastFrameAt: now,
    updatedAt: now,
  };
  getStore().sessions.set(sessionId, updated);
  return updated;
}

export function recordScreenshareInput(
  sessionId: string,
): ScreenshareSession | null {
  const session = getStore().sessions.get(sessionId);
  if (!session) {
    return null;
  }
  const now = new Date().toISOString();
  const updated: ScreenshareSession = {
    ...session,
    inputCount: session.inputCount + 1,
    lastInputAt: now,
    updatedAt: now,
  };
  getStore().sessions.set(sessionId, updated);
  return updated;
}

export function canAccessScreenshareSession(
  session: ScreenshareSession,
  token: string | null | undefined,
): boolean {
  return session.token === token;
}

export function toPublicSession(
  session: ScreenshareSession,
): ScreensharePublicSession {
  return {
    id: session.id,
    label: session.label,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stoppedAt: session.stoppedAt,
    platform: session.platform,
    frameCount: session.frameCount,
    inputCount: session.inputCount,
    lastFrameAt: session.lastFrameAt,
    lastInputAt: session.lastInputAt,
  };
}

function describeScreenshareReadiness(
  session: ScreenshareSession,
  unavailable: string[],
): string {
  if (session.status !== "active") {
    return "Desktop stream is stopped.";
  }
  if (unavailable.length > 0) {
    return `Desktop stream needs attention: ${unavailable.join(", ")}`;
  }
  return "Desktop stream is unavailable.";
}

export function getScreenshareCapabilities(): DesktopControlCapabilities {
  return detectDesktopControlCapabilities();
}

export function buildScreenshareAppSession(
  session: ScreenshareSession,
): AppSessionState {
  const capabilities = getScreenshareCapabilities();
  const ready =
    session.status === "active" &&
    capabilities.headfulGui.available &&
    capabilities.screenshot.available &&
    capabilities.computerUse.available;
  const unavailable = Object.entries(capabilities)
    .filter(([, capability]) => !capability.available)
    .map(([name]) => name);

  return {
    sessionId: session.id,
    appName: SCREENSHARE_APP_NAME,
    mode: "spectate-and-steer",
    status: ready ? "streaming" : "degraded",
    displayName: SCREENSHARE_DISPLAY_NAME,
    canSendCommands: ready,
    controls: [],
    summary: ready
      ? "Desktop stream is ready for remote control."
      : describeScreenshareReadiness(session, unavailable),
    suggestedPrompts: [
      "Start a fresh screen share session",
      "List visible desktop windows",
      "Stop the current screen share",
    ],
    telemetry: {
      platform: session.platform,
      frameCount: session.frameCount,
      inputCount: session.inputCount,
      lastFrameAt: session.lastFrameAt,
      lastInputAt: session.lastInputAt,
      screenshot: capabilities.screenshot.available,
      computerUse: capabilities.computerUse.available,
      headfulGui: capabilities.headfulGui.available,
    },
  };
}
