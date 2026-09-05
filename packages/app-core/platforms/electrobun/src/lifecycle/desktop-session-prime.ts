/** Implements Electrobun desktop desktop session prime ts behavior for app-core shell integration. */
import { Session } from "electrobun/bun";
import { logger } from "../logger";
import { resolveMainWindowPartition } from "../main-window-session";
import {
  type DesktopSession,
  installDesktopSessionCookies,
  isLoopbackBase,
  loadOrCreateDesktopSession,
} from "../native/auth-bridge";
import type { PushableWindow } from "./agent-ready-publish";
import { reloadRendererAfterDesktopSessionPrime } from "./desktop-session-renderer-ready";

// Tracks whether the desktop loopback session has already been primed for the
// current process lifetime. The bridge is idempotent on disk, but cookie jar
// writes are cheap and we don't need to repeat them on every status tick.
let desktopSessionPrimed = false;
let desktopSessionGeneration = 0;
let desktopSessionPrimeInFlight: Promise<void> | null = null;
let desktopSessionPendingPrime: DesktopSessionPrimeRequest | null = null;

interface DesktopSessionPrimeRequest {
  apiBase: string;
  rendererOrigin: string;
  generation: number;
}

interface DesktopSessionBackendStatus {
  state: string;
  port: number | null;
  startedAt: number | null;
}

/**
 * Track the backend generation that owns loopback browser-session rows.
 * Metadata-only status emissions keep the same port and start timestamp, so
 * they must not invalidate cookies or fan out new one-shot proof sockets.
 */
export function createDesktopSessionGenerationTracker(): (
  status: DesktopSessionBackendStatus,
) => boolean {
  let port: number | null = null;
  let startedAt: number | null = null;
  return (status) => {
    if (
      status.state !== "running" ||
      status.port === null ||
      status.startedAt === null
    ) {
      return false;
    }
    if (status.port === port && status.startedAt === startedAt) return false;
    port = status.port;
    startedAt = status.startedAt;
    return true;
  };
}

/**
 * Reset the primed flag so the next call to primeDesktopSessionAuth() re-runs
 * the bridge. Used when the embedded agent rebinds to a new loopback port —
 * cookies installed for the old origin don't authenticate the new one.
 */
export function markDesktopSessionStale(): void {
  desktopSessionPrimed = false;
  desktopSessionGeneration += 1;
}

async function runDesktopSessionPrime(
  apiBase: string,
  rendererOrigin: string,
  generation: number,
): Promise<void> {
  let session: DesktopSession | null;
  try {
    // A persisted session can outlive the embedded backend process that owns
    // its database row. Re-prove filesystem co-location and mint for every
    // agent generation; persistence remains available to browser-bridge callers
    // that explicitly use loadOrCreateDesktopSession's default reuse behavior.
    session = await loadOrCreateDesktopSession({
      apiBase,
      reusePersistedSession: false,
    });
  } catch (err) {
    logger.warn(
      `[Main] Desktop auth bridge failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!session) {
    logger.info(
      "[Main] Desktop auth bridge produced no session; renderer will use the standard login flow.",
    );
    return;
  }

  try {
    const partition = resolveMainWindowPartition(process.env);
    const electrobunSession =
      partition !== null
        ? Session.fromPartition(partition)
        : Session.defaultSession;
    const installer = electrobunSession.cookies as {
      set: Parameters<typeof installDesktopSessionCookies>[0]["set"];
    };
    const touched = installDesktopSessionCookies(installer, session, {
      apiOrigin: apiBase,
      rendererOrigin,
    });
    if (generation === desktopSessionGeneration) {
      desktopSessionPrimed = true;
    }
    logger.info(
      `[Main] Desktop loopback session primed on ${touched.join(", ") || "<no targets>"}`,
    );
  } catch (err) {
    logger.warn(
      `[Main] Desktop auth cookie install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function drainDesktopSessionPrimes(
  initialRequest: DesktopSessionPrimeRequest,
): Promise<void> {
  let request = initialRequest;
  for (;;) {
    await runDesktopSessionPrime(
      request.apiBase,
      request.rendererOrigin,
      request.generation,
    );
    const pending = desktopSessionPendingPrime;
    desktopSessionPendingPrime = null;
    if (!pending) return;
    if (
      desktopSessionPrimed &&
      pending.generation === desktopSessionGeneration
    ) {
      return;
    }
    request = pending;
  }
}

/**
 * Best-effort: mint a loopback-only desktop session and install the
 * cookies into the main window's session jar so the renderer's first /api
 * request is already authenticated. Failure is silent — the renderer falls
 * back to the standard login flow.
 *
 * Loopback-only enforcement is implemented server-side: the auth-context
 * resolver MUST refuse a session marked loopback-only on a non-loopback
 * request. The bridge does not — and cannot — be that boundary.
 */
export async function primeDesktopSessionAuth(
  apiBase: string,
  rendererOrigin: string,
): Promise<boolean> {
  if (desktopSessionPrimed) return true;
  const request = {
    apiBase,
    rendererOrigin,
    generation: desktopSessionGeneration,
  };
  if (desktopSessionPrimeInFlight) {
    desktopSessionPendingPrime = request;
  } else {
    desktopSessionPrimeInFlight = drainDesktopSessionPrimes(request).finally(
      () => {
        desktopSessionPendingPrime = null;
        desktopSessionPrimeInFlight = null;
      },
    );
  }
  await desktopSessionPrimeInFlight;
  return desktopSessionPrimed;
}

export interface ExternalRuntimeDesktopWindow extends PushableWindow {
  webview: {
    loadURL(url: string): void;
    rpc?: unknown;
  };
}

export interface ExternalDesktopRuntimeInitOptions {
  mode: "local" | "external" | "disabled";
  externalApiBase?: string | null;
  externalReachability?: "verified" | "unavailable";
  env?: Record<string, string | undefined>;
  currentWindow: ExternalRuntimeDesktopWindow | null;
  resolveRendererOrigin?: (
    env: Record<string, string | undefined>,
  ) => string | null | undefined;
  resolveApiToken?: (
    env: Record<string, string | undefined>,
  ) => string | null | undefined;
  resolveQualifiedToken?: (
    externalApiBase: string,
  ) => string | null | undefined;
  publishAgentApiBase: (
    rendererBase: string,
    apiToken: string,
    windows: Iterable<PushableWindow>,
  ) => void;
  collectOpenWindows: () => Iterable<PushableWindow>;
  setAgentReady: (ready: boolean) => void;
  resolveRendererUrl: () => Promise<string>;
  injectApiBaseIntoWindows: () => void;
}

export async function initializeExternalDesktopRuntimeSession(
  options: ExternalDesktopRuntimeInitOptions,
): Promise<boolean> {
  const {
    mode,
    externalApiBase,
    externalReachability,
    env = process.env as Record<string, string | undefined>,
    currentWindow,
    resolveRendererOrigin,
    resolveApiToken,
    resolveQualifiedToken,
    publishAgentApiBase,
    collectOpenWindows,
    setAgentReady,
    resolveRendererUrl,
    injectApiBaseIntoWindows,
  } = options;

  if (
    mode === "external" &&
    externalApiBase &&
    isLoopbackBase(externalApiBase)
  ) {
    const devServerRenderer = resolveRendererOrigin?.(env);
    const rendererBase = devServerRenderer ?? externalApiBase;
    const sessionPrimed = await primeDesktopSessionAuth(
      externalApiBase,
      rendererBase,
    );
    const apiToken =
      resolveApiToken?.(env) ?? resolveQualifiedToken?.(externalApiBase) ?? "";
    publishAgentApiBase(rendererBase, apiToken, collectOpenWindows());
    setAgentReady(externalReachability !== "unavailable");
    await reloadRendererAfterDesktopSessionPrime({
      sessionPrimed,
      backendGeneration: `external:${externalApiBase}`,
      window: currentWindow,
      resolveRendererUrl,
    });
    return sessionPrimed;
  }

  injectApiBaseIntoWindows();
  return false;
}
