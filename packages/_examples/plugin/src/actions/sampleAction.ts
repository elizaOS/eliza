import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type HandlerCallback,
    type State,
    composeContext,
    generateObject,
    ModelClass,
    elizaLogger,
} from "@elizaos/core";

import { CreateResourceSchema, isCreateResourceContent } from "../types";

import { createResourceTemplate } from "../templates";

export const createResourceAction: Action = {
    name: "CREATE_RESOURCE",
    description: "Create a new resource with the specified details",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.character.settings.secrets?.API_KEY;
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: object,
        callback: HandlerCallback
    ) => {
        try {
            const context = composeContext({
                state,
                template: createResourceTemplate,
            });

            const resourceDetails = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.SMALL,
                schema: CreateResourceSchema,
            });

            if (!isCreateResourceContent(resourceDetails.object)) {
                callback({ text: "Invalid resource details provided." }, []);
                return;
            }

            // persist relevant data if needed to memory/knowledge
            // const memory = {
            //     type: "resource",
            //     content: resourceDetails.object,
            //     timestamp: new Date().toISOString()
            // };

            // await runtime.storeMemory(memory);

            callback(
                {
                    text: `Resource created successfully:
- Name: ${resourceDetails.object.name}
- Type: ${resourceDetails.object.type}
- Description: ${resourceDetails.object.description}
- Tags: ${resourceDetails.object.tags.join(", ")}

Resource has been stored in memory.`,
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error creating resource:", error);
            callback(
                { text: "Failed to create resource. Please check the logs." },
                []
            );
        }
    },
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
};
