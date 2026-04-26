/**
 * @module plugin-app-control
 * @description elizaOS plugin that lets the Milady agent launch, close, list,
 * relaunch, load-from-directory, and create Milady apps.
 *
 * Surface:
 * - One unified `APP` action (sub-modes: launch / relaunch / list /
 *   load_from_directory / create). Legacy `LAUNCH_APP`, `CLOSE_APP`, and
 *   `LIST_RUNNING_APPS` names remain as similes on the unified action.
 * - `available_apps` provider — installed + running apps for the planner.
 * - `AppRegistryService` — persists load_from_directory registrations and
 *   re-registers them on boot.
 * - `AppVerificationService` — owned by Agent B; left intact below.
 *
 * Standalone single-purpose action factories (createLaunchAppAction,
 * createCloseAppAction, createListRunningAppsAction) are still exported
 * for direct callers/tests but are NOT registered in the plugin's actions
 * array — the unified `APP` action covers their planner surface via
 * similes.
 */

import type { Plugin } from "@elizaos/core";
import { appAction, createAppAction } from "./actions/app.js";
import { closeAppAction, createCloseAppAction } from "./actions/close-app.js";
import {
	createLaunchAppAction,
	launchAppAction,
} from "./actions/launch-app.js";
import {
	createListRunningAppsAction,
	listRunningAppsAction,
} from "./actions/list-running-apps.js";
import { availableAppsProvider } from "./providers/available-apps.js";
import { AppRegistryService } from "./services/app-registry-service.js";
// === appended by Agent B (AppVerificationService) ===
// Agent C: do not remove; reorder freely
import { AppVerificationService } from "./services/app-verification.js";
// === end Agent B block ===

export type { AppControlClient } from "./client/api.js";
export { createAppControlClient } from "./client/api.js";
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
	AppRegistryService,
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
} from "./services/app-registry-service.js";
export type {
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "./types.js";
export {
	appAction,
	createAppAction,
	closeAppAction,
	createCloseAppAction,
	createLaunchAppAction,
	createListRunningAppsAction,
	launchAppAction,
	listRunningAppsAction,
};
export { availableAppsProvider };
export type { AppMode } from "./actions/app.js";

export const appControlPlugin: Plugin = {
	name: "app-control",
	description:
		"Launch, close, list, relaunch, load, and create Milady apps from agent chat. Backed by the Milady dashboard /api/apps/* HTTP surface.",
	actions: [appAction],
	providers: [availableAppsProvider],
	services: [
		AppRegistryService,
		// === appended by Agent B (AppVerificationService) ===
		// Agent C: do not remove; reorder freely
		AppVerificationService,
		// === end Agent B block ===
	],
};

export default appControlPlugin;
