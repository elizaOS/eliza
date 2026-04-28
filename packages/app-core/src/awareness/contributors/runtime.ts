/**
 * Runtime contributor — reports model, provider, and OS platform.
 */

import type { AwarenessContributor } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export const runtimeContributor: AwarenessContributor = {
  id: "runtime",
  position: 10,
  cacheTtl: 300_000,
  invalidateOn: ["config-changed", "runtime-restarted"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const model =
      ((runtime.character?.settings as Record<string, unknown>)
        ?.model as string) ?? "unknown";
    const provider =
      (runtime.getSetting?.("MODEL_PROVIDER") as string) ??
      ((runtime.character?.settings as Record<string, unknown>)
        ?.modelProvider as string) ??
      "unknown";
    const platform =
      typeof process !== "undefined" ? process.platform : "unknown";

    // Ensure <= 80 chars: "Model: {model} via {provider} | OS: {platform}"
    const suffix = ` via ${provider} | OS: ${platform}`;
    const prefix = "Model: ";
    const budget = 80 - prefix.length - suffix.length;
    const truncatedModel =
      model.length > budget
        ? `${model.slice(0, Math.max(budget - 1, 3))}\u2026`
        : model;

    return `${prefix}${truncatedModel}${suffix}`;
  },
};
