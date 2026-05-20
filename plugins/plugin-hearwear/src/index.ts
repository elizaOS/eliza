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
import { FacewearService } from "./services/facewear-service.ts";
import { SmartglassesService } from "./services/smartglasses-service.ts";
import { XRSessionService } from "./services/xr-session-service.ts";

export const facewearPlugin: Plugin = {
  name: "@elizaos/plugin-hearwear",
  description:
    "Unified hearwear plugin — Meta Quest 3, XReal, Even Realities G1/G2, Apple Vision Pro. WebXR streaming, BLE smartglasses, view panels, device management.",

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
  ],

  views: [
    {
      id: "hearwear",
      viewType: "gui",
      path: "/apps/hearwear",
      label: "Hearwear",
      description:
        "Manage all connected XR devices and smartglasses — Meta Quest, XReal, Even Realities, Apple Vision Pro.",
      icon: "Glasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FacewearView",
      tags: ["hearwear", "xr", "smartglasses", "wearable"],
      visibleInManager: true,
      desktopTabEnabled: true,
      capabilities: [
        {
          id: "connect-device",
          description: "Connect to any supported hearwear device.",
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
    {
      id: "hearwear",
      viewType: "tui",
      path: "/apps/hearwear/tui",
      label: "Hearwear TUI",
      description: "Terminal UI for hearwear device management.",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FacewearView",
      tags: ["hearwear", "xr", "smartglasses", "tui"],
    },
    {
      id: "hearwear",
      viewType: "xr",
      path: "/apps/hearwear/xr",
      label: "Hearwear XR",
      description: "XR view for hearwear device status and control.",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FacewearView",
      tags: ["hearwear", "xr", "smartglasses", "wearable"],
    },
    {
      id: "smartglasses",
      viewType: "gui",
      path: "/apps/smartglasses",
      label: "Smartglasses",
      description:
        "Pair, test, configure, and export diagnostics for a complete Even Realities headset.",
      icon: "Glasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SmartglassesView",
      tags: [
        "hearwear",
        "smartglasses",
        "wearable",
        "bluetooth",
        "wifi",
        "hardware",
        "even-realities",
      ],
      visibleInManager: true,
      desktopTabEnabled: true,
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
    {
      id: "smartglasses",
      viewType: "tui",
      path: "/apps/smartglasses/tui",
      label: "Smartglasses TUI",
      description:
        "Terminal UI for smartglasses setup and diagnostics from the shared view.",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SmartglassesView",
      tags: ["hearwear", "smartglasses", "wearable", "hardware", "tui"],
    },
    {
      id: "smartglasses",
      viewType: "xr",
      path: "/apps/smartglasses/xr",
      label: "Smartglasses XR",
      description:
        "XR smartglasses setup and diagnostics panel from the same component as the GUI view.",
      icon: "Glasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SmartglassesView",
      tags: [
        "hearwear",
        "smartglasses",
        "wearable",
        "bluetooth",
        "hardware",
        "xr",
      ],
      visibleInManager: false,
    },
  ],

  app: {
    navTabs: [
      {
        id: "hearwear",
        label: "Hearwear",
        icon: "Glasses",
        path: "/apps/hearwear",
        componentExport: "@elizaos/plugin-hearwear#FacewearView",
      },
      {
        id: "smartglasses",
        label: "Smartglasses",
        icon: "Glasses",
        path: "/apps/smartglasses",
        componentExport: "@elizaos/plugin-hearwear/register#SmartglassesView",
      },
    ],
  },

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
