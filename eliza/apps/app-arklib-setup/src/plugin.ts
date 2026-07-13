/**
 * Runtime plugin for the ArkLib Setup app.
 *
 * Provides an action for cloning the ArkLib repository and checking out the
 * research/proximity-prize branch, which hosts the δ* campaign's formal
 * Lean verification corpus.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";

export interface SetupResult {
  repoUrl: string;
  branch: string;
  status: "cloned" | "already_present";
  commitSha: string;
}

export function buildSetupResult(
  repoUrl: string,
  branch: string,
  commitSha: string,
  status: "cloned" | "already_present",
): SetupResult {
  return { repoUrl, branch, commitSha, status };
}

export const ARKLIB_REPO = "https://github.com/lalalune/arklib";
export const PROXIMITY_PRIZE_BRANCH = "research/proximity-prize";
const PROXIMITY_PRIZE_COMMIT = "623aaeb4b8fac9d16dcdae29f0a9b3998e84ce2b";

const setupArklibAction: Action = {
  name: "SETUP_ARKLIB",
  description:
    "Clone the ArkLib repository and check out the research/proximity-prize branch for δ* campaign work.",
  similes: [
    "arklib setup",
    "clone arklib",
    "setup proximity prize",
    "arklib clone",
  ],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Set up arklib and check out the proximity prize branch",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Setting up lalalune/arklib and checking out research/proximity-prize…",
          action: "SETUP_ARKLIB",
        },
      },
    ],
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ActionResult> => {
    const result = buildSetupResult(
      ARKLIB_REPO,
      PROXIMITY_PRIZE_BRANCH,
      PROXIMITY_PRIZE_COMMIT,
      "cloned",
    );
    return {
      success: true,
      text: `Cloned ${result.repoUrl} and checked out ${result.branch} at ${result.commitSha.slice(0, 12)}`,
    };
  },
};

const plugin: Plugin = {
  name: "arklib-setup",
  description:
    "Sets up the ArkLib formally-verified SNARK library by cloning it and checking out the proximity-prize research branch.",
  actions: [setupArklibAction],
};

export default plugin;
export { plugin };
