import { z } from "zod";
import { inject, injectable } from "inversify";
import {
    type IAgentRuntime,
    type Memory,
    type HandlerCallback,
    type State,
    elizaLogger,
} from "@elizaos/core";
import {
    property,
    globalContainer,
    BaseInjectableAction,
    type ActionOptions
} from "@elizaos/plugin-di";

import { SampleProvider } from "../providers/sampleProvider";

/**
 * The content class for the action
 */
export class CreateResourceContent {
    @property({
        description: "Name of the resource",
        schema: z.string(),
    })
    name: string;

    @property({
        description: "Type of resource (document, image, video)",
        schema: z.string(),
    })
    type: string;

    @property({
        description: "Description of the resource",
        schema: z.string(),
    })
    description: string;

    @property({
        description: "Array of tags to categorize the resource",
        schema: z.array(z.string()),
    })
    tags: string[];
}

/**
 * Options for the CreateResource action
 */
const options: ActionOptions<CreateResourceContent> = {
    name: "CREATE_RESOURCE",
    similes: [],
    description: "Create a new resource with the specified details",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a new resource with the name 'Resource1' and type 'TypeA'",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Resource created successfully:
- Name: Resource1
- Type: TypeA`,
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a new resource with the name 'Resource2' and type 'TypeB'",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: `Resource created successfully:
- Name: Resource2
- Type: TypeB`,
                },
            },
        ],
    ],
    contentClass: CreateResourceContent,
};

/**
 * CreateResourceAction
 */
@injectable()
export class CreateResourceAction extends BaseInjectableAction<CreateResourceContent> {
    private sampleProvider: SampleProvider;

    constructor(sampleProvider: SampleProvider) {
        super(options);
        this.sampleProvider = sampleProvider;
    }

    async validate(
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<boolean> {
        return !!runtime.character.settings.secrets?.API_KEY;
    }

    async execute(
        content: CreateResourceContent | null,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        callback?: HandlerCallback
    ): Promise<any | null> {
        if (!content) {
            const error = "No content provided for the action.";
            elizaLogger.warn(error);
            await callback?.({ text: error }, []);
            return;
        }

        // Call injected provider to do some work
        try {
            const result = await this.sampleProvider.get(
                runtime,
                message,
                state
            );
            if (!result) {
                elizaLogger.warn("Provider did not return a result.");
            } else {
                elizaLogger.info("Privder result:", result);
            }
            // Use result in callback
        } catch (error) {
            elizaLogger.error("Provider error:", error);
        }

        // persist relevant data if needed to memory/knowledge
        // const memory = {
        //     type: "resource",
        //     content: resourceDetails.object,
        //     timestamp: new Date().toISOString()
        // };

        // await runtime.storeMemory(memory);

        callback?.(
            {
                text: `Resource created successfully:
- Name: ${content.name}
- Type: ${content.type}
- Description: ${content.description}
- Tags: ${content.tags.join(", ")}

Resource has been stored in memory.`,
            },
            []
        );
    }
}

// Register the action with the global container
globalContainer.bind(CreateResourceAction).toSelf().inRequestScope();
