import {
    type Action,
    generateText,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    generateObject,
} from "@elizaos/core";
import type { CdpAgentkit } from "@coinbase/cdp-agentkit-core";
import { CdpToolkit, type Tool } from "@coinbase/cdp-langchain";

type GetAgentKitActionsParams = {
    getClient: () => Promise<CdpAgentkit>;
    config?: {
        networkId?: string;
    };
};

/**
 * Get all AgentKit actions
 */
export async function getAgentKitActions({
    getClient,
}: GetAgentKitActionsParams): Promise<Action[]> {
    const agentkit = await getClient();
    const cdpToolkit = new CdpToolkit(agentkit);
    const tools = cdpToolkit.getTools();
    const actions = tools.map((tool: Tool) => ({
        name: tool.name.toUpperCase(),
        description: tool.description,
        similes: [],
        validate: async () => true,
        handler: async (
            runtime: IAgentRuntime,
            message: Memory,
            state: State | undefined,
            options?: Record<string, unknown>,
            callback?: HandlerCallback
        ): Promise<boolean> => {
            try {
                const client = await getClient();
                let currentState =
                    state ?? (await runtime.composeState(message));
                currentState = await runtime.updateRecentMessageState(
                    currentState
                );

                const parameterContext = composeParameterContext(
                    tool,
                    currentState
                );
                const parameters = await generateParameters(
                    runtime,
                    parameterContext,
                    tool
                );

                const result = await executeToolAction(
                    tool,
                    parameters,
                    client
                );

                const responseContext = composeResponseContext(
                    tool,
                    result,
                    currentState
                );
                const response = await generateResponse(
                    runtime,
                    responseContext
                );

                callback?.({ text: response, content: result });
                return true;
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                callback?.({
                    text: `Error executing action ${tool.name}: ${errorMessage}`,
                    content: { error: errorMessage },
                });
                return false;
            }
        },
        examples: [],
    }));
    return actions;
}

async function executeToolAction(
    tool: Tool,
    parameters: any,
    client: CdpAgentkit
): Promise<unknown> {
    const toolkit = new CdpToolkit(client);
    const tools = toolkit.getTools();
    const selectedTool = tools.find((t) => t.name === tool.name);

    if (!selectedTool) {
        throw new Error(`Tool ${tool.name} not found`);
    }

    return await selectedTool.call(parameters);
}

function composeParameterContext(tool: any, state: State): string {
    const contextTemplate = `{{recentMessages}}

Given the recent messages, extract the following information for the action "${tool.name}":
${tool.description}
`;
    return composeContext({ state, template: contextTemplate });
}

async function generateParameters(
    runtime: IAgentRuntime,
    context: string,
    tool: Tool
): Promise<unknown> {
    const { object } = await generateObject({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
        schema: tool.schema,
    });

    return object;
}

function composeResponseContext(
    tool: Tool,
    result: unknown,
    state: State
): string {
    const responseTemplate = `
# Action Examples
{{actionExamples}}

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

The action "${tool.name}" was executed successfully.
Here is the result:
${JSON.stringify(result)}

{{actions}}

Respond to the message knowing that the action was successful and these were the previous messages:
{{recentMessages}}
`;
    return composeContext({ state, template: responseTemplate });
}

async function generateResponse(
    runtime: IAgentRuntime,
    context: string
): Promise<string> {
    return generateText({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
    });
}
