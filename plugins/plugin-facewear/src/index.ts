import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { facewearConnectAction } from "./actions/facewear-connect.ts";
import { facewearDebugAction } from "./actions/facewear-debug.ts";
import { facewearControlAction } from "./actions/facewear-control.ts";
import { facewearStatusAction } from "./actions/facewear-status.ts";
import { displayFacewearTextAction } from "./actions/display-text.ts";
import { facewearMicrophoneAction } from "./actions/microphone.ts";
import {
  facewearOpenViewAction,
  facewearCloseViewAction,
  facewearSwitchViewAction,
  facewearListViewsAction,
  facewearResizeViewAction,
} from "./actions/view-actions.ts";
import { facewearQueryVisionAction } from "./actions/vision-query.ts";
import { facewearContextProvider } from "./providers/facewear-context.ts";
import { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
import { connectRoute } from "./routes/connect.ts";
import { facewearDevicesRoute, facewearDeviceRoute, facewearStatusRoute } from "./routes/device-config.ts";
import { simulatorRoute } from "./routes/simulator-route.ts";
import { statusRoute } from "./routes/status.ts";
import { viewHostRoute } from "./routes/view-host.ts";
import { viewsRoute } from "./routes/views.ts";
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
      id: "facewear",
      viewType: "gui",
      path: "/apps/facewear",
      label: "Facewear",
      description: "Manage all connected XR devices and smartglasses — Meta Quest, XReal, Even Realities, Apple Vision Pro.",
      icon: "Glasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FacewearView",
      tags: ["facewear", "xr", "smartglasses", "wearable"],
      visibleInManager: true,
      desktopTabEnabled: true,
      capabilities: [
        { id: "connect-device", description: "Connect to any supported facewear device." },
        { id: "manage-views", description: "Open and manage XR view panels on headsets." },
        { id: "device-diagnostics", description: "Run hardware diagnostics on connected devices." },
        { id: "emulator", description: "Launch the device emulator for any supported platform." },
      ],
    },
    {
      id: "facewear",
      viewType: "tui",
      path: "/apps/facewear/tui",
      label: "Facewear TUI",
      description: "Terminal UI for facewear device management.",
      bundlePath: "dist/views/bundle.js",
      componentExport: "FacewearView",
      tags: ["facewear", "xr", "smartglasses", "tui"],
    },
    {
      id: "facewear",
      viewType: "xr",
      path: "/apps/facewear/xr",
      label: "Facewear XR",
      description: "XR view for facewear device status and control.",
      tags: ["facewear", "xr", "smartglasses", "wearable"],
    },
  ],

  app: {
    navTabs: [
      {
        id: "facewear",
        label: "Facewear",
        icon: "Glasses",
        path: "/apps/facewear",
        componentExport: "@elizaos/plugin-facewear#FacewearView",
      },
      {
        id: "smartglasses",
        label: "Smartglasses",
        icon: "Glasses",
        path: "/apps/smartglasses",
        componentExport:
          "@elizaos/plugin-facewear/register#SmartglassesView",
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

// Re-exports for backward compatibility
export { facewearControlAction as smartglassesControlAction } from "./actions/facewear-control.ts";
export { displayFacewearTextAction as displaySmartglassesTextAction } from "./actions/display-text.ts";
export { facewearMicrophoneAction as smartglassesMicrophoneAction } from "./actions/microphone.ts";
export { facewearStatusAction as smartglassesStatusAction } from "./actions/facewear-status.ts";
export * from "./protocol/smartglasses.ts";
export type * from "./protocol/xr.ts";
export { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
export { AudioPipeline } from "./services/audio-pipeline.ts";
export { VisionPipeline } from "./services/vision-pipeline.ts";
export {
  XR_SERVICE_TYPE,
  XR_WS_PORT_DEFAULT,
  XRSessionService,
} from "./services/xr-session-service.ts";
export {
  SMARTGLASSES_AUDIO_EVENT,
  SMARTGLASSES_AUTO_INIT_SETTING,
  SMARTGLASSES_EVENT,
  SMARTGLASSES_INIT_MODE_SETTING,
  SMARTGLASSES_SCAN_TIMEOUT_SETTING,
  SMARTGLASSES_SERVICE_NAME,
  SMARTGLASSES_TRANSCRIPT_EVENT,
  SMARTGLASSES_TRANSPORT_SETTING,
  FACEWEAR_AUTO_INIT_SETTING,
  FACEWEAR_INIT_MODE_SETTING,
  FACEWEAR_SCAN_TIMEOUT_SETTING,
  FACEWEAR_SMARTGLASSES_TRANSPORT_SETTING,
  SmartglassesService,
  getSmartglassesService,
  setSmartglassesAudioDecoderForRuntime,
  setSmartglassesTransportForRuntime,
} from "./services/smartglasses-service.ts";
export type {
  SmartglassesAudioDecoder,
  SmartglassesDisplayMode,
  SmartglassesRsvpOptions,
  SmartglassesStatus,
  SmartglassesWriteTarget,
} from "./services/smartglasses-service.ts";
export { FACEWEAR_SERVICE_TYPE, FacewearService } from "./services/facewear-service.ts";
export { DEVICE_REGISTRY, getDeviceProfile, getAllDeviceProfiles } from "./devices/registry.ts";
export type { FacewearDeviceType, FacewearDeviceProfile } from "./devices/registry.ts";
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
