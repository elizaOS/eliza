export * from "./threeJs.js";
import { elizaLogger, generateText, ModelClass } from "@ai16z/eliza";
import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    State,
} from "@ai16z/eliza";




export const threeJsPlugin: Plugin = {
    name: "threeJs",
    description: "Pipeline for generating 3D videos",
    actions: [],
    evaluators: [],
    providers: [],
};
