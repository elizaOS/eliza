import { logger } from "../logger";
import type { BrowserWindow } from "electrobun/bun";
import type { SendToWebview } from "../types.js";
import { getAgentManager } from "./agent";
import { getBrowserWorkspaceManager } from "./browser-workspace";
import { getCameraManager } from "./camera";
import { getCanvasManager } from "./canvas";
import { getDesktopManager } from "./desktop";
import { getGatewayDiscovery } from "./gateway";
import { getGpuWindowManager } from "./gpu-window";
import { getLocationManager } from "./location";
import { getMusicPlayerManager } from "./music-player";
import { getPermissionManager } from "./permissions";
import { getScreenCaptureManager } from "./screencapture";
import { isStewardLocalEnabled, stopSteward } from "./steward";
import { getSwabbleManager } from "./swabble";
import { getTalkModeManager } from "./talkmode";

const NATIVE_DISPOSE_TIMEOUT_MS = 10_000;

export function initializeNativeModules(
	mainWindow: BrowserWindow,
	sendToWebview: SendToWebview,
): void {
	const desktop = getDesktopManager();
	desktop.setMainWindow(mainWindow);
	desktop.setSendToWebview(sendToWebview);

	getAgentManager().setSendToWebview(sendToWebview);
	getBrowserWorkspaceManager().setSendToWebview(sendToWebview);
	getCameraManager().setSendToWebview(sendToWebview);
	getCanvasManager().setSendToWebview(sendToWebview);
	getGatewayDiscovery().setSendToWebview(sendToWebview);
	getGpuWindowManager().setSendToWebview(sendToWebview);
	getLocationManager().setSendToWebview(sendToWebview);
	getPermissionManager().setSendToWebview(sendToWebview);
	const screencapture = getScreenCaptureManager();
	screencapture.setSendToWebview(sendToWebview);
	screencapture.setMainWebview(mainWindow.webview);
	getSwabbleManager().setSendToWebview(sendToWebview);
	getTalkModeManager().setSendToWebview(sendToWebview);
}

export async function disposeNativeModules(): Promise<void> {
	const managers = [
		["agent", getAgentManager()],
		["browser-workspace", getBrowserWorkspaceManager()],
		["camera", getCameraManager()],
		["canvas", getCanvasManager()],
		["desktop", getDesktopManager()],
		["gateway", getGatewayDiscovery()],
		["gpu-window", getGpuWindowManager()],
		["location", getLocationManager()],
		["permissions", getPermissionManager()],
		["screencapture", getScreenCaptureManager()],
		["swabble", getSwabbleManager()],
		["talkmode", getTalkModeManager()],
		["music-player", getMusicPlayerManager()],
	] as const;

	// Stop steward sidecar if it was running
	if (isStewardLocalEnabled()) {
		try {
			await stopSteward();
		} catch (err) {
			logger.warn(
				`[Native] steward dispose failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const settleDisposals = Promise.allSettled(
		managers.map(async ([name, manager]) => {
			try {
				await Promise.resolve(manager.dispose());
			} catch (err) {
				logger.warn(
					`[Native] ${name} dispose failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
	const timedOut = await Promise.race([
		settleDisposals.then(() => false),
		new Promise<boolean>((resolve) => {
			timeoutHandle = setTimeout(
				() => resolve(true),
				NATIVE_DISPOSE_TIMEOUT_MS,
			);
		}),
	]);
	if (timeoutHandle) {
		clearTimeout(timeoutHandle);
	}

	if (timedOut) {
		logger.warn(
			`[Native] Timed out waiting ${NATIVE_DISPOSE_TIMEOUT_MS}ms for native module disposal`,
		);
	} else {
		await settleDisposals;
	}
}
