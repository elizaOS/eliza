/**
 * Features contributor — reports enabled/disabled feature flags.
 */

import type { AwarenessContributor } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";

export const featuresContributor: AwarenessContributor = {
  id: "features",
  position: 80,
  cacheTtl: 300_000,
  invalidateOn: ["config-changed"],
  trusted: true,

  async summary(runtime: IAgentRuntime): Promise<string> {
    const check = (key: string): boolean => {
      const val = runtime.getSetting?.(key);
      return val === true || val === "true";
    };

    const coding = check("CODING_ENABLED") || check("WORKSPACE_ENABLED");
    const vision = check("VISION_ENABLED");
    const voice = check("VOICE_ENABLED");
    const shell = check("SHELL_ENABLED");

    const icon = (on: boolean) => (on ? "\u2713" : "\u2717");

    return `Features: coding${icon(coding)} vision${icon(vision)} voice${icon(voice)} shell${icon(shell)}`;
  },
};
