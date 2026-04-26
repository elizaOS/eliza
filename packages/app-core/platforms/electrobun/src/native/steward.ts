/**
 * Steward Native Module for Electrobun
 *
 * Integrates the Steward sidecar into the Electrobun desktop app lifecycle.
 * Manages startup, shutdown, and exposes status to the renderer via RPC.
 *
 * Follows the same pattern as `agent.ts` — spawns Steward as a child process
 * and manages its lifecycle from the Electrobun main process.
 *
 * When running in local mode (STEWARD_LOCAL=true), this module:
 *   1. Starts the steward sidecar before the the app agent
 *   2. After sidecar is healthy and credentials are available, sets env vars
 *      (STEWARD_API_URL, STEWARD_AGENT_TOKEN, etc.) so the the app agent's
 *      steward-bridge picks them up automatically
 *   3. Pushes steward status to the renderer via sendToWebview
 *   4. Stops the sidecar on app shutdown
 */

import {
  createDesktopStewardSidecar,
  type StewardSidecar,
  type StewardSidecarStatus,
} from "../../../../src/services/steward-sidecar";
import { saveStewardCredentials } from "@elizaos/app-steward";
import { getBrandConfig } from "../brand-config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusChangeCallback = (status: StewardSidecarStatus) => void;
type SendToWebviewFn = (message: string, payload?: unknown) => void;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let sidecar: StewardSidecar | null = null;
let statusListeners: StatusChangeCallback[] = [];
let sendToWebview: SendToWebviewFn | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the sendToWebview function so steward status updates reach the renderer.
 */
export function setStewardSendToWebview(fn: SendToWebviewFn): void {
  sendToWebview = fn;
}

/**
 * Get or create the Steward sidecar singleton.
 *
 * The sidecar is NOT started automatically — call `startSteward()` explicitly
 * during app initialization so the UI can show a loading indicator.
 */
export function getStewardSidecar(): StewardSidecar {
  if (!sidecar) {
    sidecar = createDesktopStewardSidecar({
      onStatusChange: (status) => {
        // Push status to renderer
        sendToWebview?.("stewardStatusUpdate", status);

        for (const listener of statusListeners) {
          try {
            listener(status);
          } catch (err) {
            console.warn("[Steward] Status listener error:", err);
          }
        }
      },
      onLog: (line, stream) => {
        // In dev, forward steward logs. In production, only errors.
        if (stream === "stderr" || process.env.NODE_ENV !== "production") {
          const prefix = stream === "stderr" ? "[Steward:err]" : "[Steward]";
          console.log(`${prefix} ${line}`);
        }
      },
    });
  }
  return sidecar;
}

/**
 * Configure process.env with steward credentials so the the app agent's
 * steward-bridge.ts can discover steward automatically.
 *
 * This must be called BEFORE the the app agent starts so `createStewardClient()`
 * in steward-bridge.ts picks up STEWARD_API_URL.
 */
function configureStewardEnvFromCredentials(): void {
  if (!sidecar) return;

  const credentials = sidecar.getCredentials();
  const apiBase = sidecar.getApiBase();

  // Set STEWARD_API_URL so steward-bridge.ts finds the local steward
  process.env.STEWARD_API_URL = apiBase;

  if (credentials) {
    // Set agent token for bearer auth
    if (credentials.agentToken) {
      process.env.STEWARD_AGENT_TOKEN = credentials.agentToken;
    }

    // Set API key and tenant for tenant-scoped requests
    if (credentials.tenantApiKey) {
      process.env.STEWARD_API_KEY = credentials.tenantApiKey;
    }
    if (credentials.tenantId) {
      process.env.STEWARD_TENANT_ID = credentials.tenantId;
    }

    // Set agent ID
    if (credentials.agentId) {
      process.env.STEWARD_AGENT_ID = credentials.agentId;
    }

    try {
      saveStewardCredentials({
        apiUrl: apiBase,
        tenantId: credentials.tenantId ?? "",
        agentId: credentials.agentId ?? "",
        apiKey: credentials.tenantApiKey ?? "",
        agentToken: credentials.agentToken ?? "",
        walletAddresses: {
          evm: credentials.walletAddress ?? undefined,
        },
        agentName: credentials.agentId ?? undefined,
      });
    } catch (err) {
      console.warn("[Steward] Failed to persist credentials:", err);
    }

    console.log(
      `[Steward] Env configured: API=${apiBase} agent=${credentials.agentId} wallet=${credentials.walletAddress}`,
    );
  } else {
    console.warn("[Steward] Sidecar running but no credentials available yet");
  }
}

/**
 * Start the Steward sidecar and wait for it to be healthy.
 * Handles first-launch wallet creation automatically.
 * Configures env vars for the the app agent's steward bridge.
 *
 * Returns the status after startup (running or error).
 */
export async function startSteward(): Promise<StewardSidecarStatus> {
  const steward = getStewardSidecar();
  const status = steward.getStatus();

  if (status.state === "running") {
    console.log("[Steward] Already running, skipping start");
    return status;
  }

  console.log("[Steward] Starting sidecar...");

  // Push initial "starting" status to renderer
  sendToWebview?.("stewardStatusUpdate", {
    state: "starting",
    port: null,
    pid: null,
    error: null,
    restartCount: 0,
    walletAddress: null,
    agentId: null,
    tenantId: null,
    startedAt: null,
  });

  try {
    const result = await steward.start();
    console.log(
      `[Steward] Running on port ${result.port}, wallet: ${result.walletAddress ?? "none"}`,
    );

    // Configure env vars so the the app agent's steward bridge finds steward
    configureStewardEnvFromCredentials();

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Steward] Failed to start:", msg);
    return steward.getStatus();
  }
}

/**
 * Stop the Steward sidecar gracefully.
 * Called during app shutdown.
 */
export async function stopSteward(): Promise<void> {
  if (!sidecar) return;
  console.log("[Steward] Stopping sidecar...");
  await sidecar.stop();
  console.log("[Steward] Stopped");
}

/**
 * Restart the Steward sidecar (stop + start).
 * Useful for recovery from errors or after a reset.
 */
export async function restartSteward(): Promise<StewardSidecarStatus> {
  if (!sidecar) {
    return startSteward();
  }
  console.log("[Steward] Restarting sidecar...");
  const result = await sidecar.restart();
  configureStewardEnvFromCredentials();
  return result;
}

/**
 * Reset steward data — deletes credentials and PGLite data, then restarts.
 * Use when PGLite data is corrupted or user wants a fresh wallet.
 */
export async function resetSteward(): Promise<StewardSidecarStatus> {
  console.log("[Steward] Resetting steward data...");

  // Stop the sidecar first
  await stopSteward();

  // Delete credentials and data directory
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dataDir =
    process.env.STEWARD_DATA_DIR ||
    path.join(home, `.${getBrandConfig().namespace}`, "steward");

  // Safety: ensure dataDir resolves inside the app namespace dir to prevent accidental
  // deletion of unrelated directories via env var manipulation.
  const resolvedDataDir = path.resolve(dataDir);
  const stateBase = path.resolve(
    path.join(home, `.${getBrandConfig().namespace}`),
  );
  if (
    !resolvedDataDir.startsWith(stateBase + path.sep) &&
    resolvedDataDir !== stateBase
  ) {
    throw new Error(
      `[Steward] Refusing to delete dataDir outside ~/.${getBrandConfig().namespace}/: ${resolvedDataDir}`,
    );
  }

  if (fs.existsSync(resolvedDataDir)) {
    console.log(`[Steward] Removing data directory: ${resolvedDataDir}`);
    fs.rmSync(resolvedDataDir, { recursive: true, force: true });
  }

  // Clear env vars
  delete process.env.STEWARD_API_URL;
  delete process.env.STEWARD_AGENT_TOKEN;
  delete process.env.STEWARD_API_KEY;
  delete process.env.STEWARD_TENANT_ID;
  delete process.env.STEWARD_AGENT_ID;

  // Recreate sidecar (old one has stale state)
  sidecar = null;

  // Start fresh
  return startSteward();
}

/**
 * Register a callback for Steward status changes.
 * Returns an unsubscribe function.
 */
export function onStewardStatusChange(
  callback: StatusChangeCallback,
): () => void {
  statusListeners.push(callback);
  return () => {
    statusListeners = statusListeners.filter((l) => l !== callback);
  };
}

/**
 * Get the current Steward sidecar status.
 */
export function getStewardStatus(): StewardSidecarStatus {
  if (!sidecar) {
    return {
      state: "stopped",
      port: null,
      pid: null,
      error: null,
      restartCount: 0,
      walletAddress: null,
      agentId: null,
      tenantId: null,
      startedAt: null,
    };
  }
  return sidecar.getStatus();
}

/**
 * Get the Steward API base URL (e.g. http://127.0.0.1:3200).
 * Returns null if steward isn't configured.
 */
export function getStewardApiBase(): string | null {
  if (!sidecar) return null;
  const status = sidecar.getStatus();
  if (status.state !== "running" || !status.port) return null;
  return sidecar.getApiBase();
}

/**
 * Check if the STEWARD_LOCAL environment flag is set.
 * When false, Steward sidecar should not be started.
 */
export function isStewardLocalEnabled(): boolean {
  return process.env.STEWARD_LOCAL === "true";
}
