import {
    Plugin,
} from "@ai16z/eliza";
import { createResourceAction } from "../actions/sampleAction";
import { sampleProvider } from "../providers/sampleProvider";
import { sampleEvaluator } from "../evaluators/sampleEvalutor";

export const samplePlugin: Plugin = {
    name: "sample",
    description: "Enables creation and management of generic resources",
    actions: [createResourceAction],
    providers: [sampleProvider],
    evaluators: [sampleEvaluator],
    // separate examples will be added for services and clients
    services: [],
    clients: [],
};
