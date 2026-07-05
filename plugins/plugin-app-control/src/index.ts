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
import { viewCommandShortcutEvaluator } from "./evaluators/view-command-shortcut.js";
import { viewContextEvaluator } from "./evaluators/view-context.js";
import { viewFollowupRoutingEvaluator } from "./evaluators/view-followup-routing.js";
import { availableAppsProvider } from "./providers/available-apps.js";
import { currentViewProvider } from "./providers/current-view.js";
import {
	applyCurrentViewComposeHook,
	CURRENT_VIEW_HOOK_ID,
} from "./runtime/current-view-hook.js";
import { AppRegistryService } from "./services/app-registry-service.js";
import { AppVerificationService } from "./services/app-verification.js";
import { AppWorkerHostService } from "./services/app-worker-host-service.js";
import { VerificationRoomBridgeService } from "./services/verification-room-bridge.js";
import { viewNavigationShortcuts } from "./shortcuts.js";

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
export {
	__matcherData,
	MATCHER_VIEW_IDS,
	matchViewCommand,
} from "./actions/view-command-matcher.js";
export type { ViewsMode } from "./actions/views.js";
export {
	closeAllViewsAction,
	closeViewAction,
	createViewsAction,
	createViewsAliasAction,
	viewsAction,
} from "./actions/views.js";
export type { ViewSummary } from "./actions/views-client.js";
export { INTENT_VIEW_IDS, resolveIntentView } from "./actions/views-show.js";
export type { AppControlClient } from "./client/api.js";
export { createAppControlClient } from "./client/api.js";
export { viewCommandShortcutEvaluator } from "./evaluators/view-command-shortcut.js";
export {
	CONTEXT_VIEWS,
	viewContextEvaluator,
} from "./evaluators/view-context.js";
export { viewFollowupRoutingEvaluator } from "./evaluators/view-followup-routing.js";
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
export {
	VIEW_NAVIGATION_SHORTCUT_ID,
	viewNavigationShortcuts,
} from "./shortcuts.js";
export type {
	AppLaunchResult,
	AppRunSummary,
	AppStopResult,
	InstalledAppInfo,
} from "./types.js";
export { appAction, availableAppsProvider, createAppAction };

// In a terminal host (the Node agent, no DOM), register the views-manager,
// settings, and voice views so they render inline in the terminal. Lazy +
// DOM-guarded so the terminal engine stays out of browser/mobile bundles.
if (typeof window === "undefined") {
	void import("./register-terminal-view.js")
		.then((m) => {
			m.registerViewManagerTerminalView();
			m.registerSettingsTerminalView();
			m.registerVoiceTerminalView();
		})
		.catch(() => {
			// Terminal rendering is best-effort; never block plugin load.
		});
}

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
	shortcuts: viewNavigationShortcuts,
	// Three-stage view-switch cascade:
	//  1. EARLY  — viewCommandShortcutEvaluator (responseHandlerEvaluator, no
	//     model): on an explicit multilingual command ("open settings"), FORCES
	//     the VIEWS action so navigation never depends on weak-model selection.
	//  2. ACTION — viewsAction: navigates; deterministic target via
	//     resolveIntentView → matchViewCommand. The agent may also pick it.
	//  3. POST   — viewContextEvaluator (small model): catches CONTEXTUAL intent
	//     the user never spelled out ("fix the login bug" -> task-coordinator).
	//     Its gate defers whenever resolveIntentView already matches a direct
	//     surface (the rigid matchViewCommand matcher, or the legacy intent
	//     rules it falls back to), so it never contends with the action.
	// view-followup-routing handles mutation follow-ups on the active view.
	evaluators: [viewContextEvaluator],
	responseHandlerEvaluators: [
		viewCommandShortcutEvaluator,
		viewFollowupRoutingEvaluator,
	],
	providers: [availableAppsProvider, currentViewProvider],
	services: [
		AppRegistryService,
		AppVerificationService,
		AppWorkerHostService,
		VerificationRoomBridgeService,
	],
	async init(_config, runtime) {
		// Inject the `current_view` acknowledgement provider into the curated
		// Stage-1 response state ONLY on switch turns (gating in
		// applyCurrentViewComposeHook), so non-switch turns pay no prompt/token
		// cost. The planner state already composes `current_view` by default.
		runtime.registerPipelineHook({
			id: CURRENT_VIEW_HOOK_ID,
			phase: "compose_state_providers",
			handler: (_rt, ctx) => {
				if (ctx.phase !== "compose_state_providers") return;
				applyCurrentViewComposeHook(ctx);
			},
		});
	},
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
		// ONE declaration → GUI + XR + TUI, all drawn from the single
		// ViewManagerView spatial-catalog source (the rich deduped manager:
		// collapse-by-id + modality chips + per-view open/available state). The
		// terminal surface renders the registered ViewManagerSpatialView via the
		// spatial terminal registry (see register-terminal-view.tsx). `modalities`
		// is a plain literal here (index.ts is not in the view bundle), so no
		// brand-new `@elizaos/core` runtime export reaches the bundle build.
		{
			id: "views-manager",
			label: "Views",
			description: "Browse and open available views contributed by plugins",
			icon: "LayoutGrid",
			path: "/views",
			modalities: ["gui", "xr", "tui"],
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
					id: "terminal-open-view",
					description: "Open a listed view from the terminal view manager",
					params: {
						viewId: {
							type: "string",
							description: "Stable id of the view to open",
							required: true,
						},
					},
				},
				{
					id: "terminal-list-views",
					description: "Return the TUI-mode view list as structured data",
				},
			],
			// Headless capability handler (#8798): both capabilities are answerable
			// server-side over loopback, so the agent can list/open views even when
			// no terminal frontend is actively responding to a `view:interact`
			// round-trip. This is the reference implementation that keeps
			// `serverInteract` a live extension point rather than dead type surface.
			serverInteract: async (capability, params) => {
				const client = createViewsClient();
				if (capability === "terminal-list-views") {
					return { views: await client.listViews() };
				}
				if (capability === "terminal-open-view") {
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
		// Terminal-only surfaces: settings and voice/transcription render in the
		// agent terminal via the spatial terminal registry (see
		// register-terminal-view.tsx). They have no GUI bundle — the TUI mounts the
		// registered SettingsSpatialView / VoiceSpatialView directly. `modalities:
		// ["tui"]` lists them under GET /api/views?viewType=tui so the terminal can
		// open them; a host pushes live config via set*TerminalSnapshot.
		{
			id: "settings",
			label: "Settings",
			description: "Agent settings and configuration",
			icon: "Settings",
			path: "/settings/tui",
			modalities: ["tui"],
			visibleInManager: true,
			capabilities: [
				{
					id: "settings-get-state",
					description:
						"Return the current settings snapshot as structured data",
				},
			],
		},
		{
			id: "voice",
			label: "Voice",
			description: "Voice configuration and recent transcript",
			icon: "Mic",
			path: "/voice/tui",
			modalities: ["tui"],
			visibleInManager: true,
			capabilities: [
				{
					id: "voice-get-state",
					description:
						"Return the current voice/transcript snapshot as structured data",
				},
			],
		},
	],
};

export default appControlPlugin;
