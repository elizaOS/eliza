import { CreateResourceAction } from "./sampleAction";
import { SampleProvider } from "./sampleProvider";
import { SampleEvaluator } from "./sampleEvaluator";
import type { PluginOptions } from "../types";

export const samplePlugin: PluginOptions = {
    name: "sample",
    description: "Enables creation and management of generic resources",
    actions: [CreateResourceAction],
    providers: [SampleProvider],
    evaluators: [SampleEvaluator],
    // separate examples will be added for services and clients
    services: [],
    clients: [],
};

export default samplePlugin;
