/**
 * @module plugin-app-control
 * @description elizaOS plugin that lets the Eliza agent launch, close, list,
 * relaunch, load-from-directory, and create Eliza apps.
 *
 * Surface:
 * - One unified `APP` action (sub-modes: launch / relaunch / list /
 *   load_from_directory / create).
 * - `available_apps` provider — installed + running apps for the planner.
 * - `AppRegistryService` — persists load_from_directory registrations and
 *   re-registers them on boot.
 * - `AppVerificationService` — verifies created apps and plugins.
 */

import type { Plugin } from "@elizaos/core";
import { appAction, createAppAction } from "./actions/app.js";
import { availableAppsProvider } from "./providers/available-apps.js";
import { AppRegistryService } from "./services/app-registry-service.js";
import { AppVerificationService } from "./services/app-verification.js";
import { AppWorkerHostService } from "./services/app-worker-host-service.js";
import { VerificationRoomBridgeService } from "./services/verification-room-bridge.js";

export type { AppMode } from "./actions/app.js";
export type { AppControlClient } from "./client/api.js";
export { createAppControlClient } from "./client/api.js";
export {
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
	AppRegistryService,
} from "./services/app-registry-service.js";
export {
	APP_WORKER_HOST_SERVICE_TYPE,
	AppWorkerHostService,
	type SpawnedWorkerSnapshot,
} from "./services/app-worker-host-service.js";
export {
	AppVerificationService,
	type CheckResult,
	type VerificationCheck,
	type VerificationCheckKind,
	type VerificationProfile,
	type VerificationResult,
	type VerifyOptions,
} from "./services/index.js";
export {
	VERIFICATION_ROOM_BRIDGE_SERVICE_TYPE,
	VerificationRoomBridgeService,
} from "./services/verification-room-bridge.js";
export type {
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "./types.js";
export { appAction, availableAppsProvider, createAppAction };

export const appControlPlugin: Plugin = {
	name: "app-control",
	description:
		"Launch, close, list, relaunch, load, and create Eliza apps from agent chat. Backed by the Eliza dashboard /api/apps/* HTTP surface.",
	actions: [appAction],
	providers: [availableAppsProvider],
	services: [
		AppRegistryService,
		AppVerificationService,
		AppWorkerHostService,
		VerificationRoomBridgeService,
	],
};

export default appControlPlugin;
