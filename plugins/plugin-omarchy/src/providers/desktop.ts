/**
 * Read-only provider that gives the planner a bounded Omarchy desktop snapshot
 * when the runtime is actually hosted on Omarchy Linux.
 */
import type { Provider, ProviderResult } from "@elizaos/core";
import { isOmarchyHost, type OmarchyBridge, omarchyBridge } from "../bridge.js";

export function createOmarchyDesktopProvider(
  bridge: OmarchyBridge = omarchyBridge,
  hostCheck: () => boolean = isOmarchyHost,
): Provider {
  return {
    name: "omarchyDesktop",
    description:
      "Current Omarchy version, theme, shell plugin state, and Eliza shell integration status.",
    descriptionCompressed: "Current Omarchy desktop state.",
    dynamic: true,
    contexts: ["system", "automation", "settings"],
    contextGate: { anyOf: ["system", "automation", "settings"] },
    cacheScope: "turn",
    get: async (): Promise<ProviderResult> => {
      if (!hostCheck()) return { text: "" };
      const snapshot = await bridge.snapshot();
      if (!snapshot.available) {
        return {
          text: "Omarchy desktop integration is unavailable.",
          values: { omarchyAvailable: false },
          data: snapshot,
        };
      }

      const elizaShell = snapshot.plugins?.find(
        (plugin) => plugin.id === "elizaos.eliza",
      );
      const text = [
        `Omarchy ${snapshot.version ?? "unknown"}`,
        snapshot.theme ? `theme ${snapshot.theme}` : null,
        elizaShell
          ? `Eliza shell plugin ${elizaShell.enabled ? "enabled" : "disabled"}`
          : "Eliza shell plugin not installed",
      ]
        .filter((value): value is string => Boolean(value))
        .join("; ");

      return {
        text: `${text}.`,
        values: {
          omarchyAvailable: true,
          omarchyVersion: snapshot.version,
          omarchyTheme: snapshot.theme,
          omarchyElizaPluginInstalled: Boolean(elizaShell),
          omarchyElizaPluginEnabled: elizaShell?.enabled === true,
        },
        data: snapshot,
      };
    },
  };
}

export const omarchyDesktopProvider = createOmarchyDesktopProvider();
