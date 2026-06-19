import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  DEVICE_REGISTRY,
  type FacewearDeviceType,
} from "../devices/registry.ts";
import {
  FACEWEAR_SERVICE_TYPE,
  type FacewearService,
} from "../services/facewear-service.ts";

export const facewearConnectAction: Action = {
  name: "FACEWEAR_CONNECT",
  description:
    "Show connection instructions for a facewear device (Meta Quest, XReal, Even Realities, Apple Vision Pro).",
  similes: [
    "CONNECT_GLASSES",
    "CONNECT_HEADSET",
    "PAIR_DEVICE",
    "CONNECT_FACEWEAR",
  ],
  examples: [
    [
      { name: "{{user1}}", content: { text: "How do I connect my Quest 3?" } },
      {
        name: "{{user2}}",
        content: {
          text: "To connect your Meta Quest 3, open a browser in VR, navigate to the pairing URL, and tap Allow on the camera/mic prompts.",
        },
      },
    ],
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    const text = (message.content.text ?? "").toLowerCase();
    let deviceType: FacewearDeviceType = "meta-quest";
    if (text.includes("xreal") || text.includes("air")) deviceType = "xreal";
    else if (
      text.includes("even") ||
      text.includes("g1") ||
      text.includes("g2")
    )
      deviceType = "even-realities";
    else if (
      text.includes("vision") ||
      text.includes("apple") ||
      text.includes("avp")
    )
      deviceType = "apple-vision-pro";

    const profile = DEVICE_REGISTRY[deviceType];
    const svc = runtime.getService<FacewearService>(FACEWEAR_SERVICE_TYPE);
    const connected = svc?.getConnectedDevices() ?? [];

    let instructions = `**${profile.displayName}** (${profile.manufacturer})\n\n`;
    if (profile.connectionType === "ble") {
      instructions += "**Connection method:** Bluetooth BLE\n";
      instructions += "1. Enable Bluetooth on your phone/computer\n";
      instructions += "2. Put on your Even Realities glasses\n";
      instructions +=
        "3. The elizaOS agent will auto-detect via Noble BLE or Web Bluetooth\n";
      instructions +=
        "4. For native Android: install the Even Realities companion app\n";
    } else {
      instructions += "**Connection method:** WebXR over WebSocket\n";
      instructions += "1. Start the elizaOS agent (this server)\n";
      instructions +=
        "2. Visit `/api/xr/connect` for the QR code + pairing URL\n";
      instructions += "3. Open the URL on your headset browser\n";
      instructions += "4. Allow camera and microphone when prompted\n";
      if (profile.nativeAppPath) {
        instructions += `5. For native APK: see \`${profile.nativeAppPath}/README.md\`\n`;
      }
    }
    if (connected.length > 0) {
      instructions += `\n**Currently connected:** ${connected.map((d) => d.deviceType ?? d.kind).join(", ")}`;
    }

    await callback?.({ text: instructions });
    return { success: true };
  },
};
