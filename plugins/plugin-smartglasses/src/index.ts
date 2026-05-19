import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { smartglassesControlAction } from "./actions/control.js";
import { displaySmartglassesTextAction } from "./actions/display-text.js";
import { smartglassesMicrophoneAction } from "./actions/microphone.js";
import { smartglassesStatusAction } from "./actions/status.js";
import { smartglassesStatusProvider } from "./providers/status.js";
import { SmartglassesService } from "./services/smartglasses-service.js";

export const smartglassesPlugin: Plugin = {
  name: "@elizaos/plugin-smartglasses",
  description:
    "Even Realities G1/G2 smartglasses integration: text display, microphone audio streaming, and side-tap microphone controls.",
  services: [SmartglassesService as ServiceClass],
  actions: [
    smartglassesControlAction,
    displaySmartglassesTextAction,
    smartglassesMicrophoneAction,
    smartglassesStatusAction,
  ],
  providers: [smartglassesStatusProvider],
  views: [
    {
      id: "smartglasses",
      label: "Smartglasses",
      description:
        "Pair, test, configure, and export diagnostics for a complete smartglasses headset.",
      icon: "Glasses",
      path: "/apps/smartglasses",
      bundlePath: "dist/views/bundle.js",
      componentExport: "SmartglassesView",
      tags: [
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
      ],
    },
  ],
  app: {
    navTabs: [
      {
        id: "smartglasses",
        label: "Smartglasses",
        icon: "Glasses",
        path: "/apps/smartglasses",
        componentExport: "@elizaos/plugin-smartglasses#SmartglassesView",
      },
    ],
  },
  async dispose(runtime: IAgentRuntime) {
    await runtime
      .getService<SmartglassesService>(SmartglassesService.serviceType)
      ?.stop();
  },
};

export default smartglassesPlugin;

export { smartglassesControlAction } from "./actions/control.js";
export { displaySmartglassesTextAction } from "./actions/display-text.js";
export { smartglassesMicrophoneAction } from "./actions/microphone.js";
export { smartglassesStatusAction } from "./actions/status.js";
export * from "./protocol.js";
export { smartglassesStatusProvider } from "./providers/status.js";
export {
  getSmartglassesService,
  SMARTGLASSES_AUDIO_EVENT,
  SMARTGLASSES_EVENT,
  SMARTGLASSES_SCAN_TIMEOUT_SETTING,
  SMARTGLASSES_SERVICE_NAME,
  SMARTGLASSES_TRANSCRIPT_EVENT,
  SMARTGLASSES_TRANSPORT_SETTING,
  type SmartglassesAudioDecoder,
  type SmartglassesDisplayMode,
  type SmartglassesRsvpOptions,
  SmartglassesService,
  type SmartglassesStatus,
  type SmartglassesWriteTarget,
  setSmartglassesAudioDecoderForRuntime,
  setSmartglassesTransportForRuntime,
} from "./services/smartglasses-service.js";
export {
  EvenBridgeTransport,
  getGlobalEvenBridgeTransport,
} from "./transport/even-bridge.js";
export { MockSmartglassesTransport } from "./transport/mock.js";
export type {
  NobleAdapterLike,
  NobleCharacteristicLike,
  NobleG1TransportOptions,
  NoblePeripheralLike,
} from "./transport/noble.js";
export { getNobleG1Transport, NobleG1Transport } from "./transport/noble.js";
export type {
  SmartglassesTransport,
  SmartglassesTransportFactory,
} from "./transport/types.js";
export {
  getWebBluetoothG1Transport,
  WebBluetoothG1Transport,
} from "./transport/web-bluetooth.js";
export { SmartglassesView } from "./ui/SmartglassesView.js";
