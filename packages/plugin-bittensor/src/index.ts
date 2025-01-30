import { Plugin } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";

import { analyzeImage, analysisHistory } from "./actions/sn34.ts";
import { factEvaluator } from "./evaluators/fact.ts";
import { timeProvider } from "./providers/time.ts";

export * as actions from "./actions/index.ts";
export * as evaluators from "./evaluators/index.ts";
export * as providers from "./providers/index.ts";


export const bittensorPlugin: Plugin = {
    name: "bittensor",
    description: "Utilize the BitMind API to access a range of digital commodities, including inference, media generation, and deepfake detection, on Bittensor's decentralized AI network.",
    actions: [
        analyzeImage,
        analysisHistory
    ],
    evaluators: [factEvaluator],
    providers: [timeProvider],
    clients: [TwitterClientInterface]
};
export default bittensorPlugin;