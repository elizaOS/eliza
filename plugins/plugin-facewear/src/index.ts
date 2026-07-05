/**
 * Facewear plugin registration wires XR headset streaming, Even Realities
 * smartglasses control, views, routes, providers, and services into elizaOS.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { displayFacewearTextAction } from "./actions/display-text.ts";
import { facewearConnectAction } from "./actions/facewear-connect.ts";
import { facewearControlAction } from "./actions/facewear-control.ts";
import { facewearDebugAction } from "./actions/facewear-debug.ts";
import { facewearStatusAction } from "./actions/facewear-status.ts";
import { facewearMicrophoneAction } from "./actions/microphone.ts";
import {
	facewearCloseViewAction,
	facewearListViewsAction,
	facewearOpenViewAction,
	facewearResizeViewAction,
	facewearSwitchViewAction,
} from "./actions/view-actions.ts";
import { facewearQueryVisionAction } from "./actions/vision-query.ts";
import { facewearSetupRuntimeAction } from "./actions/xr-runtime-setup.ts";
import { facewearContextProvider } from "./providers/facewear-context.ts";
import { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
import { connectRoute } from "./routes/connect.ts";
import {
	facewearDeviceRoute,
	facewearDevicesRoute,
	facewearStatusRoute,
} from "./routes/device-config.ts";
import { simulatorRoute } from "./routes/simulator-route.ts";
import { statusRoute } from "./routes/status.ts";
import { viewHostRoute } from "./routes/view-host.ts";
import { viewsRoute } from "./routes/views.ts";
import { facewearXrRuntimeRoute } from "./routes/xr-runtime.ts";
import { FacewearService } from "./services/facewear-service.ts";
import { SmartglassesService } from "./services/smartglasses-service.ts";
import { XRSessionService } from "./services/xr-session-service.ts";

export const facewearPlugin: Plugin = {
	name: "@elizaos/plugin-facewear",
	description:
		"Unified facewear plugin — Meta Quest 3, XReal, Even Realities G1/G2, Apple Vision Pro. WebXR streaming, BLE smartglasses, view panels, device management.",

	services: [FacewearService, XRSessionService, SmartglassesService],
	actions: [
		facewearConnectAction,
		facewearDebugAction,
		facewearControlAction,
		facewearStatusAction,
		displayFacewearTextAction,
		facewearMicrophoneAction,
		facewearOpenViewAction,
		facewearCloseViewAction,
		facewearSwitchViewAction,
		facewearListViewsAction,
		facewearResizeViewAction,
		facewearQueryVisionAction,
		facewearSetupRuntimeAction,
	],
	providers: [facewearContextProvider, smartglassesStatusProvider],
	routes: [
		statusRoute,
		connectRoute,
		viewsRoute,
		viewHostRoute,
		simulatorRoute,
		facewearDevicesRoute,
		facewearDeviceRoute,
		facewearStatusRoute,
		facewearXrRuntimeRoute,
	],

	views: [
		// ONE declaration → GUI + XR + TUI, all drawn from the single
		// FacewearSpatialView source (via the FacewearView data wrapper).
		// `modalities` is a plain literal here (index.ts is not in the view bundle),
		// so no brand-new `@elizaos/core` runtime export reaches the bundle build.
		{
			id: "facewear",
			viewKind: "preview",
			path: "/apps/facewear",
			label: "Facewear",
			description:
				"Manage all connected XR devices and smartglasses — Meta Quest, XReal, Even Realities, Apple Vision Pro.",
			icon: "Glasses",
			heroImagePath: "assets/hero-facewear.png",
			// GUI config moved to Settings -> Wearables (register.ts); the served
			// standalone view keeps only the agent-facing XR + TUI surfaces.
			modalities: ["xr", "tui"],
			bundlePath: "dist/views/bundle.js",
			// First-party instrumented view (data-agent-id controls): grant the
			// agent-surface capability so the view broker admits agent-driven
			// fills/clicks (#13452 manifest gate).
			surface: { capabilities: ["agent-surface"] },
			componentExport: "FacewearView",
			tags: ["facewear", "xr", "smartglasses", "wearable"],
			relatedActions: [
				"FACEWEAR_CONNECT",
				"FACEWEAR_DEBUG",
				"SMARTGLASSES_CONTROL",
				"SMARTGLASSES_STATUS",
				"SMARTGLASSES_DISPLAY_TEXT",
				"SMARTGLASSES_MICROPHONE",
				"XR_OPEN_VIEW",
				"XR_CLOSE_VIEW",
				"XR_SWITCH_VIEW",
				"XR_LIST_VIEWS",
				"XR_RESIZE_VIEW",
				"XR_QUERY_VISION",
			],
			// Wearables config now lives under Settings → Wearables (see register.ts),
			// not as standalone launcher views. The view defs are retained only so the
			// agent keeps serving the XR/TUI surfaces and the in-headset view host.
			visibleInManager: false,
			desktopTabEnabled: false,
			capabilities: [
				{
					id: "connect-device",
					description: "Connect to any supported facewear device.",
				},
				{
					id: "manage-views",
					description: "Open and manage XR view panels on headsets.",
				},
				{
					id: "device-diagnostics",
					description: "Run hardware diagnostics on connected devices.",
				},
				{
					id: "emulator",
					description: "Launch the device emulator for any supported platform.",
				},
			],
		},
		// ONE declaration → GUI + XR + TUI, all drawn from the single
		// SmartglassesSpatialView source (via the SmartglassesPanelView wrapper).
		{
			id: "smartglasses",
			viewKind: "preview",
			path: "/apps/smartglasses",
			label: "Smartglasses",
			description:
				"Pair, test, configure, and export diagnostics for a complete Even Realities headset.",
			icon: "Glasses",
			heroImagePath: "assets/hero-smartglasses.png",
			// GUI config moved to Settings -> Wearables (register.ts); the served
			// standalone view keeps only the agent-facing XR + TUI surfaces.
			modalities: ["xr", "tui"],
			bundlePath: "dist/views/bundle.js",
			// First-party instrumented view (data-agent-id controls): grant the
			// agent-surface capability so the view broker admits agent-driven
			// fills/clicks (#13452 manifest gate).
			surface: { capabilities: ["agent-surface"] },
			componentExport: "SmartglassesPanelView",
			tags: [
				"facewear",
				"smartglasses",
				"wearable",
				"bluetooth",
				"wifi",
				"hardware",
				"even-realities",
			],
			// Wearables config now lives under Settings → Wearables (see register.ts),
			// not as standalone launcher views. The view defs are retained only so the
			// agent keeps serving the XR/TUI surfaces and the in-headset view host.
			visibleInManager: false,
			desktopTabEnabled: false,
			capabilities: [
				{
					id: "connect-headset",
					description:
						"Guide the user through whole-headset pairing and connection.",
				},
				{
					id: "run-hardware-check",
					description:
						"Exercise display, serial, microphone, and settings paths and build a diagnostics report.",
				},
				{
					id: "guided-side-tap-audio-validation",
					description:
						"Guide single-tap microphone enable, speech audio, and double-tap microphone disable validation.",
				},
				{
					id: "configure-wifi",
					description:
						"Scan and configure headset Wi-Fi when a native bridge exposes Wi-Fi APIs.",
				},
			],
		},
	],

	async dispose(runtime: IAgentRuntime) {
		await runtime
			.getService<FacewearService>(FacewearService.serviceType)
			?.stop();
	},
};

export default facewearPlugin;
export const smartglassesPlugin = facewearPlugin;

export { displayFacewearTextAction as displaySmartglassesTextAction } from "./actions/display-text.ts";
// Re-exports for backward compatibility
export { facewearControlAction as smartglassesControlAction } from "./actions/facewear-control.ts";
export { facewearStatusAction as smartglassesStatusAction } from "./actions/facewear-status.ts";
export { facewearMicrophoneAction as smartglassesMicrophoneAction } from "./actions/microphone.ts";
// NOTE: the React view wrappers (FacewearView / SmartglassesPanelView) are NOT
// re-exported here — that drags React/@elizaos/ui into the Node agent bundle and
// fails plugin load. The app loads them via the browser entry (src/register.ts)
// + the Vite view bundle (componentExport from dist/views/bundle.js).
export { facewearSetupRuntimeAction } from "./actions/xr-runtime-setup.ts";
export type {
	FacewearDeviceProfile,
	FacewearDeviceType,
} from "./devices/registry.ts";
export {
	DEVICE_REGISTRY,
	getAllDeviceProfiles,
	getDeviceProfile,
} from "./devices/registry.ts";
export * from "./protocol/smartglasses.ts";
export type * from "./protocol/xr.ts";
export { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
// Desktop OpenXR runtime detection + install planning (the WebXR-on-desktop seam).
export { detectOpenXrRuntimeNow } from "./runtime/node-probe.ts";
export {
	detectOpenXrRuntime,
	type OpenXrInstallPlan,
	type OpenXrInstallStep,
	type OpenXrRuntimeName,
	type OpenXrRuntimeStatus,
	planOpenXrInstall,
	type RuntimeProbe,
} from "./runtime/openxr-runtime.ts";
export { AudioPipeline } from "./services/audio-pipeline.ts";
export {
	FACEWEAR_SERVICE_TYPE,
	FacewearService,
} from "./services/facewear-service.ts";
export type {
	SmartglassesAudioDecoder,
	SmartglassesDisplayMode,
	SmartglassesRsvpOptions,
	SmartglassesStatus,
	SmartglassesWriteTarget,
} from "./services/smartglasses-service.ts";
export {
	FACEWEAR_AUTO_INIT_SETTING,
	FACEWEAR_INIT_MODE_SETTING,
	FACEWEAR_SCAN_TIMEOUT_SETTING,
	FACEWEAR_SMARTGLASSES_TRANSPORT_SETTING,
	getSmartglassesService,
	SMARTGLASSES_AUDIO_EVENT,
	SMARTGLASSES_AUTO_INIT_SETTING,
	SMARTGLASSES_EVENT,
	SMARTGLASSES_INIT_MODE_SETTING,
	SMARTGLASSES_SCAN_TIMEOUT_SETTING,
	SMARTGLASSES_SERVICE_NAME,
	SMARTGLASSES_TRANSCRIPT_EVENT,
	SMARTGLASSES_TRANSPORT_SETTING,
	SmartglassesService,
	setSmartglassesAudioDecoderForRuntime,
	setSmartglassesTransportForRuntime,
} from "./services/smartglasses-service.ts";
export { VisionPipeline } from "./services/vision-pipeline.ts";
export {
	XR_SERVICE_TYPE,
	XR_WS_PORT_DEFAULT,
	XRSessionService,
} from "./services/xr-session-service.ts";
export {
	EvenBridgeTransport,
	getGlobalEvenBridgeTransport,
} from "./transport/even-bridge.ts";
export { MockSmartglassesTransport } from "./transport/mock.ts";
export type {
	NobleAdapterLike,
	NobleCharacteristicLike,
	NobleG1TransportOptions,
	NoblePeripheralLike,
} from "./transport/noble.ts";
export { getNobleG1Transport, NobleG1Transport } from "./transport/noble.ts";
export type {
	SmartglassesTransport,
	SmartglassesTransportFactory,
	SmartglassesWifiResult,
} from "./transport/types.ts";
export {
	getWebBluetoothG1Transport,
	WebBluetoothG1Transport,
} from "./transport/web-bluetooth.ts";
