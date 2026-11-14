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
 *   1. Starts the steward sidecar before the app agent
 *   2. After sidecar is healthy and credentials are available, sets env vars
 *      (STEWARD_API_URL, STEWARD_AGENT_TOKEN, etc.) so the app agent's
 *      steward-bridge picks them up automatically
 *   3. Pushes steward status to the renderer via sendToWebview
 *   4. Stops the sidecar on app shutdown
 */

import fs from "node:fs";
import path from "node:path";
import type {
	StewardSidecar,
	StewardSidecarStatus,
} from "../../../../src/services/steward-sidecar";
import { logger } from "../logger";
import { resolveStateDir } from "./auth-bridge";

function isStrictlyInside(dir: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), dir);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

/**
 * Guard the recursive delete in `resetSteward`: the directory must sit inside
 * the sidecar's own state root or the app state dir (so a stray
 * STEWARD_DATA_DIR cannot point the delete elsewhere), and an existing
 * directory must hold steward state (`credentials.json` or `data/`).
 */
function assertStewardDataDirDeletable(
	dataDir: string,
	allowedRoots: readonly string[],
): void {
	if (!allowedRoots.some((root) => isStrictlyInside(dataDir, root))) {
		throw new Error(
			`[Steward] Refusing to delete ${dataDir}: outside ${allowedRoots.join(" and ")}`,
		);
	}
	if (fs.existsSync(dataDir)) {
		const realDataDir = fs.realpathSync(dataDir);
		const insideRealRoot = allowedRoots.some(
			(root) =>
				fs.existsSync(root) &&
				isStrictlyInside(realDataDir, fs.realpathSync(root)),
		);
		if (!insideRealRoot) {
			throw new Error(
				`[Steward] Refusing to delete ${dataDir}: symlink resolves outside the state roots`,
			);
		}
	}
	if (
		fs.existsSync(dataDir) &&
		!fs.existsSync(path.join(dataDir, "credentials.json")) &&
		!fs.existsSync(path.join(dataDir, "data"))
	) {
		throw new Error(
			`[Steward] Refusing to delete ${dataDir}: it does not contain steward data`,
		);
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusChangeCallback = (status: StewardSidecarStatus) => void;
type SendToWebviewFn = (message: string, payload?: unknown) => void;

// ---------------------------------------------------------------------------
// Lazy runtime imports
// ---------------------------------------------------------------------------

type StewardSidecarModule = typeof import("@elizaos/app");
type StewardCredentialsModule = typeof import("@elizaos/app");

let stewardSidecarModulePromise: Promise<StewardSidecarModule> | null = null;
let stewardCredentialsModulePromise: Promise<StewardCredentialsModule> | null =
	null;

function loadStewardSidecarModule(): Promise<StewardSidecarModule> {
	stewardSidecarModulePromise ??= import("@elizaos/app");
	return stewardSidecarModulePromise;
}

function loadStewardCredentialsModule(): Promise<StewardCredentialsModule> {
	stewardCredentialsModulePromise ??= import("@elizaos/app");
	return stewardCredentialsModulePromise;
}

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
export async function getStewardSidecar(): Promise<StewardSidecar> {
	if (!sidecar) {
		const { createDesktopStewardSidecar } = await loadStewardSidecarModule();
		sidecar = createDesktopStewardSidecar({
			onStatusChange: (status) => {
				// Push status to renderer
				sendToWebview?.("stewardStatusUpdate", status);

				for (const listener of statusListeners) {
					try {
						listener(status);
					} catch (err) {
						logger.warn(
							`[Steward] Status listener error: ${err instanceof Error ? err.message : String(err)}`,
						);
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
 * Configure process.env with steward credentials so the app agent's
 * steward-bridge.ts can discover steward automatically.
 *
 * This must be called BEFORE the app agent starts so `createStewardClient()`
 * in steward-bridge.ts picks up STEWARD_API_URL.
 */
async function configureStewardEnvFromCredentials(): Promise<void> {
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
			const { saveStewardCredentials } = await loadStewardCredentialsModule();
			await saveStewardCredentials({
				apiUrl: apiBase,
				tenantId: credentials.tenantId,
				agentId: credentials.agentId,
				apiKey: credentials.tenantApiKey,
				agentToken: credentials.agentToken,
				walletAddresses: {
					evm: credentials.walletAddress,
				},
				agentName: credentials.agentId,
			});
		} catch (err) {
			logger.warn(
				`[Steward] Failed to persist credentials: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		logger.info(
			`[Steward] Env configured: API=${apiBase} agent=${credentials.agentId} wallet=${credentials.walletAddress}`,
		);
	} else {
		logger.warn("[Steward] Sidecar running but no credentials available yet");
	}
}

/**
 * Start the Steward sidecar and wait for it to be healthy.
 * Handles first-launch wallet creation automatically.
 * Configures env vars for the app agent's steward bridge.
 *
 * Returns the status after startup (running or error).
 */
export async function startSteward(): Promise<StewardSidecarStatus> {
	const steward = await getStewardSidecar();
	const status = steward.getStatus();

	if (status.state === "running") {
		logger.info("[Steward] Already running, skipping start");
		return status;
	}

	logger.info("[Steward] Starting sidecar...");

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
		logger.info(
			`[Steward] Running on port ${result.port}, wallet: ${result.walletAddress ?? "none"}`,
		);

		// Configure env vars so the app agent's steward bridge finds steward
		await configureStewardEnvFromCredentials();

		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error("[Steward] Failed to start:", msg);
		return steward.getStatus();
	}
}

/**
 * Stop the Steward sidecar gracefully.
 * Called during app shutdown.
 */
export async function stopSteward(): Promise<void> {
	if (!sidecar) return;
	logger.info("[Steward] Stopping sidecar...");
	await sidecar.stop();
	logger.info("[Steward] Stopped");
}

/**
 * Restart the Steward sidecar (stop + start).
 * Useful for recovery from errors or after a reset.
 */
export async function restartSteward(): Promise<StewardSidecarStatus> {
	if (!sidecar) {
		return startSteward();
	}
	logger.info("[Steward] Restarting sidecar...");
	const result = await sidecar.restart();
	await configureStewardEnvFromCredentials();
	return result;
}

/**
 * Reset steward data — deletes credentials and PGLite data, then restarts.
 * Use when PGLite data is corrupted or user wants a fresh wallet.
 */
export async function resetSteward(): Promise<StewardSidecarStatus> {
	logger.info("[Steward] Resetting steward data...");

	// Delete exactly the directory the sidecar is configured to use, so reset
	// and the running sidecar can never disagree about where the wallet lives.
	const resolvedDataDir = path.resolve(
		(await getStewardSidecar()).getDataDir(),
	);
	const { resolveDesktopStewardStateRoot } = await loadStewardSidecarModule();
	const allowedRoots = [resolveDesktopStewardStateRoot(), resolveStateDir()];
	assertStewardDataDirDeletable(resolvedDataDir, allowedRoots);

	await stopSteward();

	// Stopping the sidecar is asynchronous; recheck the path before deletion.
	assertStewardDataDirDeletable(resolvedDataDir, allowedRoots);
	if (fs.existsSync(resolvedDataDir)) {
		logger.info(`[Steward] Removing data directory: ${resolvedDataDir}`);
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
