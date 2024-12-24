import { Plugin } from "@ai16z/eliza";
import { sentimentEvaluator } from "./evaluators/sentiment.ts";
import { sentimentProvider } from "./providers/sentiment.ts";

export const feelPlugin: Plugin = {
    name: "feel",
    description: "Tracks and manages Ming's emotional state towards users based on their interactions",
    actions: [], // No custom actions needed yet
    evaluators: [sentimentEvaluator],
    providers: [sentimentProvider],
};
