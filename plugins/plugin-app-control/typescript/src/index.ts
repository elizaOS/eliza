/**
 * @module plugin-app-control
 * @description elizaOS plugin that lets the Milady agent launch, close, and
 * list running Milady apps. Consumed by the Apps page's right-side chat.
 *
 * All actions talk to the Milady dashboard API over loopback:
 * - `POST /api/apps/launch` to start an app
 * - `GET  /api/apps/runs` to list running runs
 * - `POST /api/apps/runs/:runId/stop` to stop a run
 * - `GET  /api/apps/installed` for name resolution
 */

import type { Plugin } from "@elizaos/core";
import { closeAppAction, createCloseAppAction } from "./actions/close-app.js";
import {
	createLaunchAppAction,
	launchAppAction,
} from "./actions/launch-app.js";
import {
	createListRunningAppsAction,
	listRunningAppsAction,
} from "./actions/list-running-apps.js";

export type { AppControlClient } from "./client/api.js";
export { createAppControlClient } from "./client/api.js";
export type {
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "./types.js";
export {
	createCloseAppAction,
	createLaunchAppAction,
	createListRunningAppsAction,
};

export const appControlPlugin: Plugin = {
	name: "app-control",
	description:
		"Launch, close, and list running Milady apps from agent chat. Backed by the Milady dashboard /api/apps/* HTTP surface.",
	actions: [launchAppAction, closeAppAction, listRunningAppsAction],
};

export default appControlPlugin;
