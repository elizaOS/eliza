/**
 * OpenXR runtime setup action reports desktop runtime detection and install
 * planning for XR headset support.
 */
import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { detectOpenXrRuntimeNow } from "../runtime/node-probe.ts";
import {
  type OpenXrInstallPlan,
  type OpenXrRuntimeStatus,
  planOpenXrInstall,
} from "../runtime/openxr-runtime.ts";

export const facewearSetupRuntimeAction: Action = {
  name: "SETUP_XR_RUNTIME",
  description:
    "Check whether a desktop OpenXR runtime (Monado/SteamVR/WMR) is installed for WebXR, and show how to install one if not.",
  similes: [
    "INSTALL_OPENXR",
    "SETUP_VR_RUNTIME",
    "SETUP_AR_RUNTIME",
    "CHECK_VR_RUNTIME",
    "FIX_WEBXR",
  ],
  examples: [
    [
      { name: "{{user1}}", content: { text: "Is my VR runtime set up?" } },
      {
        name: "{{user2}}",
        content: {
          text: "Checking your OpenXR runtime… SteamVR is active, so immersive WebXR will work on this desktop.",
        },
      },
    ],
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    const status = detectOpenXrRuntimeNow();
    const plan = planOpenXrInstall(status);
    await callback?.({ text: formatRuntimeReport(status, plan) });
    return { success: true, data: { status, plan } };
  },
};

function formatRuntimeReport(
  status: OpenXrRuntimeStatus,
  plan: OpenXrInstallPlan,
): string {
  if (status.platform === "darwin") {
    return "**VR/AR runtime — macOS**\n\nmacOS uses native WebXR on visionOS Safari; there is no OpenXR runtime to install. Open the web build in Vision Pro Safari for immersive sessions.";
  }
  if (status.installed) {
    return (
      `**VR/AR runtime — ready** ✅\n\n` +
      `Active OpenXR runtime: **${status.runtime ?? "unknown"}**` +
      (status.activeRuntimePath ? ` (\`${status.activeRuntimePath}\`)` : "") +
      `\n\nImmersive WebXR will work in the desktop app on this machine.`
    );
  }
  if (!status.webxrReady) {
    return `**VR/AR runtime — unsupported platform** (${status.platform})\n\nThis platform's browser engine does not ship the WebXR Device API.`;
  }

  let out = `**VR/AR runtime — not installed** ⚠️\n\nThe browser engine ships WebXR, but no OpenXR runtime is active, so \`navigator.xr\` cannot reach a headset yet. Install one:\n`;
  for (const [i, step] of plan.steps.entries()) {
    out += `\n**${i + 1}. ${step.title}**${step.privileged ? " _(needs admin)_" : ""}\n`;
    out += `${step.description}\n`;
    if (step.command) out += `\n\`\`\`\n${step.command}\n\`\`\`\n`;
    if (step.url) out += `${step.url}\n`;
  }
  if (status.notes.length > 0) {
    out += `\n_Notes: ${status.notes.join(" ")}_`;
  }
  return out;
}
