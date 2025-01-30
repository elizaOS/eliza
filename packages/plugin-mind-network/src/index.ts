import type { Plugin } from "@elizaos/core";

import { checkRewardAction, encryptAction, registerAction, submitVoteAction } from "./actions";

export const mindNetworkPlugin: Plugin = {
    name: "Mind Network",
    description: "Mind Network Plugin for Eliza",
    actions: [checkRewardAction, encryptAction, registerAction, submitVoteAction],
    evaluators: [],
    providers: [],
};

export default mindNetworkPlugin;
