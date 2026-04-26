/**
 * Permissions contributor — reports automation mode, shell,
 * and OS permission states so the agent understands its own
 * operational boundaries (Layer 2 of the 3-layer permission model).
 */

import {
  type AwarenessContributor,
  loadElizaConfig,
} from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

type AutomationMode = "connectors-only" | "full";

function resolveAutomationMode(): AutomationMode {
  try {
    const config = loadElizaConfig();
    const features =
      config.features && typeof config.features === "object"
        ? (config.features as Record<string, unknown>)
        : null;
    const agentAutomation =
      features?.agentAutomation &&
      typeof features.agentAutomation === "object" &&
      !Array.isArray(features.agentAutomation)
        ? (features.agentAutomation as Record<string, unknown>)
        : null;
    const mode = agentAutomation?.mode;
    if (mode === "connectors-only") return "connectors-only";
  } catch {
    // Fall through to default.
  }
  return "full";
}

export const permissionsContributor: AwarenessContributor = {
  id: "permissions",
  position: 20,
  cacheTtl: 120_000,
  invalidateOn: ["permission-changed", "config-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const shellRaw = runtime.getSetting?.("SHELL_ENABLED");
    const shellEnabled = shellRaw === true || shellRaw === "true";
    const shellIcon = shellEnabled ? "\u2713" : "\u2717";
    const autoMode = resolveAutomationMode();

    const isDarwin =
      typeof process !== "undefined" && process.platform === "darwin";

    const parts = [`auto:${autoMode}`, `shell${shellIcon}`];
    if (isDarwin) {
      parts.push("a11y? camera? mic? screen?");
    }

    return `Perms: ${parts.join(" ")}`;
  },

  async detail(
    runtime: IAgentRuntime,
    level: "brief" | "full",
  ): Promise<string> {
    const shellRaw = runtime.getSetting?.("SHELL_ENABLED");
    const shellEnabled = shellRaw === true || shellRaw === "true";
    const autoMode = resolveAutomationMode();

    const lines: string[] = ["## Permissions"];
    lines.push(`Automation mode: ${autoMode}`);
    if (autoMode === "connectors-only") {
      lines.push(
        "  → Agent can only modify connectors. Plugin install/uninstall and config changes are blocked.",
      );
    } else {
      lines.push(
        "  → Agent can configure all plugins, install/uninstall, and modify system config.",
      );
    }
    lines.push(`Shell access: ${shellEnabled ? "enabled" : "disabled"}`);
    lines.push(
      `Terminal available: ${shellEnabled && autoMode === "full" ? "yes" : "no"}`,
    );

    if (level === "full") {
      const isDarwin =
        typeof process !== "undefined" && process.platform === "darwin";
      if (isDarwin) {
        lines.push("OS permissions: accessibility?, camera?, mic?, screen?");
      }
    }

    return lines.join("\n");
  },
};
