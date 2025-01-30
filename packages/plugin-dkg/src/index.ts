import { Plugin } from "@elizaos/core";

import { dkgInsert } from "./actions/dkgInsert.ts";

import { graphSearch } from "./providers/graphSearch.ts";

import { sentimentAnalysisEvaluator } from "./evaluators/sentimentAnalysisEvaluator.ts";

export * as actions from "./actions";
export * as providers from "./providers";
export * as evaluators from "./evaluators";

export const dkgPlugin: Plugin = {
    name: "dkg",
    description:
        "Agent DKG which allows you to store memories on the OriginTrail Decentralized Knowledge Graph",
    actions: [dkgInsert],
    providers: [graphSearch],
    evaluators: [sentimentAnalysisEvaluator],
};
