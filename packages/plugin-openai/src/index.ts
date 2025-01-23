import type { Plugin } from "@elizaos/core";
import { generateTextAction } from "./actions/generateTextAction";
import { generateEmbeddingAction } from "./actions/generateEmbeddingAction";
import { analyzeSentimentAction } from "./actions/analyzeSentimentAction";
import { transcribeAudioAction } from "./actions/transcribeAudioAction";
import { moderateContentAction } from "./actions/moderateContentAction";
import { editTextAction } from "./actions/editTextAction";

// Simple terminal output
console.log("\n===============================");
console.log("      OpenAI Plugin Loaded      ");
console.log("===============================");
console.log("Name      : openai-plugin");
console.log("Version   : 0.1.0");
console.log("X Account : https://x.com/Data0x88850");
console.log("GitHub    : https://github.com/0xrubusdata");
console.log("Actions   :");
console.log("  - generateTextAction");
console.log("  - generateEmbeddingAction");
console.log("  - analyzeSentimentAction");
console.log("  - transcribeAudioAction");
console.log("  - moderateContentAction");
console.log("  - editTextAction");
console.log("===============================\n");

export const openaiPlugin: Plugin = {
    name: "openai",
    description: "OpenAI integration plugin for various AI capabilities",
    actions: [
        generateTextAction,
        generateEmbeddingAction,
        analyzeSentimentAction,
        transcribeAudioAction,
        moderateContentAction,
        editTextAction,
    ],
    evaluators: [],
    providers: [],
};

export default openaiPlugin;
