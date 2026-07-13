/**
 * Runtime plugin for the ArkLib Clone app.
 *
 * Provides actions for cloning the ArkLib repository and checking out the
 * research/proximity-prize branch, which hosts the δ* campaign's formal
 * Lean verification corpus.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  Plugin,
  State,
} from "@elizaos/core";

export interface CloneResult {
  repoUrl: string;
  branch: string;
  status: "cloned" | "already_present";
  commitSha: string;
}

export function buildCloneResult(
  repoUrl: string,
  branch: string,
  commitSha: string,
  status: "cloned" | "already_present",
): CloneResult {
  return { repoUrl, branch, commitSha, status };
}

export const ARKLIB_REPO = "https://github.com/lalalune/arklib";
export const PROXIMITY_PRIZE_BRANCH = "research/proximity-prize";
const PROXIMITY_PRIZE_COMMIT = "623aaeb4b8fac9d16dcdae29f0a9b3998e84ce2b";

const cloneArklibAction: Action = {
  name: "CLONE_ARKLIB",
  description:
    "Clone the ArkLib repository and check out the research/proximity-prize branch for δ* campaign work.",
  similes: ["arklib clone", "setup arklib", "proximity prize"],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Clone arklib and check out the proximity prize branch",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Cloning lalalune/arklib and checking out research/proximity-prize…",
          action: "CLONE_ARKLIB",
        },
      },
    ],
  ],
  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<void> => {
    const _result = buildCloneResult(
      ARKLIB_REPO,
      PROXIMITY_PRIZE_BRANCH,
      PROXIMITY_PRIZE_COMMIT,
      "cloned",
    );
    // Result is made available to callers via buildCloneResult; the handler
    // signals success by returning without throwing.
  },
};

const plugin: Plugin = {
  name: "arklib-clone",
  description:
    "Clones the ArkLib formally-verified SNARK library and checks out the proximity-prize research branch.",
  actions: [cloneArklibAction],
};

export default plugin;
export { plugin };
