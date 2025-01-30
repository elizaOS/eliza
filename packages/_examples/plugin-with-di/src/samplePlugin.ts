import type { PluginOptions } from '@elizaos/plugin-di';
import { CreateResourceAction } from "./actions/sampleAction";
import { SampleProvider } from "./providers/sampleProvider";
import { SampleEvaluator } from "./evaluators/sampleEvaluator";
import { SampleService } from './services/sampleService';

export const samplePlugin: PluginOptions = {
    name: "sample",
    description: "Enables creation and management of generic resources",
    actions: [CreateResourceAction],
    providers: [SampleProvider],
    evaluators: [SampleEvaluator],
    services: [SampleService],
    clients: [],
};

export default samplePlugin;
