/**
 * Registers the app lifecycle, shell-view, settings, and background controls
 * exposed to Eliza agents.
 *
 * Surface:
 * - One unified `APP` action (sub-modes: launch / relaunch / stop / list /
 *   load_from_directory / create).
 * - `available_apps` provider — installed + running apps for the planner.
 * - `AppRegistryService` — persists load_from_directory registrations and
 *   re-registers them on boot.
 * - `AppVerificationService` — verifies created apps and plugins.
 */

import type { Plugin } from "@elizaos/core";
import { agentSwitchAction } from "./actions/agent-switch.js";
import { appAction, createAppAction } from "./actions/app.js";
import { backgroundAction } from "./actions/background.js";
import { modelSwitchAction } from "./actions/model-switch.js";
import { settingsAction } from "./actions/settings.js";
import {
	closeAllViewsAction,
	closeViewAction,
	viewsAction,
} from "./actions/views.js";
import { createViewsClient } from "./actions/views-client.js";
import { createChoiceShortcutEvaluator } from "./evaluators/create-choice-shortcut.js";
import { availableAppsProvider } from "./providers/available-apps.js";
import { currentViewProvider } from "./providers/current-view.js";
import { AppRegistryService } from "./services/app-registry-service.js";
import { AppVerificationService } from "./services/app-verification.js";
import { AppWorkerHostService } from "./services/app-worker-host-service.js";
import { VerificationRoomBridgeService } from "./services/verification-room-bridge.js";

export {
	type AgentSwitchActionDeps,
	type AgentSwitchFn,
	type AgentSwitchOutcome,
	agentSwitchAction,
	createAgentSwitchAction,
	inferAgentSwitchProfile,
} from "./actions/agent-switch.js";
export type { AppMode } from "./actions/app.js";
export type {
	BackgroundApplyOp,
	BackgroundApplyPayload,
} from "./actions/background.js";
export {
	backgroundAction,
	createBackgroundAction,
	inferBackgroundPlan,
} from "./actions/background.js";
export {
	createModelSwitchAction,
	inferModelSwitchRequest,
	type ModelSwitchActionDeps,
	type ModelSwitchFn,
	type ModelSwitchOutcome,
	type ModelSwitchTarget,
	modelSwitchAction,
	sanctionedModelError,
} from "./actions/model-switch.js";
export {
	createSettingsAction,
	parseBooleanValue,
	parseSettingsRequest,
	resolveSectionId,
	SETTINGS_WRITE_REGISTRY,
	type SettingsActionDeps,
	type SettingsRequest,
	type SettingsRouteFetch,
	type SettingsRouteOutcome,
	type SettingsSectionCapability,
	type SettingsSectionListing,
	type SettingsVerb,
	type SettingsWritableKey,
	settingsAction,
} from "./actions/settings.js";
export type { ViewsMode } from "./actions/views.js";
export {
	closeAllViewsAction,
	closeViewAction,
	createViewsAction,
	createViewsAliasAction,
	viewsAction,
} from "./actions/views.js";
export type { ViewSummary } from "./actions/views-client.js";
export {
	type AppWorkerCapability,
	parseAppWorkerCapability,
} from "./app-worker-manifest.js";
export type { AppControlClient } from "./client/api.js";
export { createAppControlClient } from "./client/api.js";
export { createChoiceShortcutEvaluator } from "./evaluators/create-choice-shortcut.js";
export { currentViewProvider } from "./providers/current-view.js";
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
	name: "@elizaos/plugin-app-control",
	description:
		"Launch, close, list, relaunch, load, and create Eliza apps from agent chat. Backed by the Eliza dashboard /api/apps/* HTTP surface. Also manages UI views via the VIEWS action.",
	actions: [
		appAction,
		viewsAction,
		closeViewAction,
		closeAllViewsAction,
		backgroundAction,
		modelSwitchAction,
		agentSwitchAction,
		settingsAction,
	],
	// Natural-language view selection belongs to the normal Eliza planning
	// pipeline. The model chooses VIEWS and supplies structured action/view
	// parameters; this plugin only validates and executes that typed decision.
	// Persisted choice widgets keep their explicit continuation protocol because
	// they are UI state acknowledgements, not natural-language intent routing.
	evaluators: [],
	responseHandlerEvaluators: [createChoiceShortcutEvaluator],
	providers: [availableAppsProvider, currentViewProvider],
	services: [
		AppRegistryService,
		AppVerificationService,
		AppWorkerHostService,
		VerificationRoomBridgeService,
	],
	async dispose(runtime) {
		await runtime
			.getService<VerificationRoomBridgeService>(
				VerificationRoomBridgeService.serviceType,
			)
			?.stop();
		await runtime
			.getService<AppWorkerHostService>(AppWorkerHostService.serviceType)
			?.stop();
		await runtime
			.getService<AppVerificationService>(AppVerificationService.serviceType)
			?.stop();
		await runtime
			.getService<AppRegistryService>(AppRegistryService.serviceType)
			?.stop();
	},
	views: [
		{
			id: "views-manager",
			label: "Views",
			description: "Browse and open available views contributed by plugins",
			icon: "LayoutGrid",
			path: "/views",
			modalities: ["gui"],
			bundlePath: "dist/views/bundle.js",
			// First-party instrumented view (data-agent-id controls): grant the
			// agent-surface capability so the view broker admits agent-driven
			// fills/clicks (#13452 manifest gate).
			surface: { capabilities: ["agent-surface"] },
			componentExport: "ViewManagerView",
			visibleInManager: true,
			desktopTabEnabled: true,
			capabilities: [
				{
					id: "open-view",
					description: "Open a listed view from the view manager",
					params: {
						viewId: {
							type: "string",
							description: "Stable id of the view to open",
							required: true,
						},
					},
				},
				{
					id: "list-views",
					description: "Return the available view list as structured data",
				},
			],
			serverInteract: async (capability, params) => {
				const client = createViewsClient();
				if (capability === "list-views") {
					return { views: await client.listViews() };
				}
				if (capability === "open-view") {
					const viewId =
						params && typeof params.viewId === "string"
							? params.viewId
							: undefined;
					if (!viewId) {
						return { success: false, error: "viewId is required" };
					}
					const ok = await client.navigate(viewId);
					return { success: ok, viewId };
				}
				return { success: false, error: `unknown capability: ${capability}` };
			},
		},
	],
};

export default appControlPlugin;
