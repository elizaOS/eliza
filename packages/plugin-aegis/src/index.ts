import { Plugin } from "@elizaos/core";
import { evaluateIntentAction } from "./actions/evaluateIntent";

export { AegisSDK } from "./sdk/AegisSDK";
export type { AegisConfig, AegisIntent, AegisResult } from "./sdk/AegisSDK";

export const aegis12Plugin: Plugin = {
    name: "aegis12",
    description: "Aegis-12 TEE Compliance Gateway for Autonomous Agents",
    actions: [evaluateIntentAction],
    evaluators: [],
    providers: [],
};

export default aegis12Plugin;
