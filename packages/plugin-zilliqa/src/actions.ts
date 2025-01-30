import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { MODE, USDC, erc20 } from "@goat-sdk/plugin-erc20";
import { kim } from "@goat-sdk/plugin-kim";
import { sendETH } from "@goat-sdk/wallet-evm";
import { WalletClientBase } from "@goat-sdk/core";
import { zilliqa } from "@goat-sdk/plugin-zilliqa";

import {
    generateText,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    composeContext,
    elizaLogger,
} from "@elizaos/core";
import { Zilliqa } from "@zilliqa-js/zilliqa";

export async function getOnChainActions(
    evmWallet: WalletClientBase,
    zilliqaWallet: WalletClientBase
) {
    const actionsWithoutHandler = [
        {
            name: "GET_BALANCE",
            description:
                "Retrieve the balance of a zilliqa account using the GET_ZILLIQA_ADDRESS_BALANCE tool or an evm account using the GET_BALANCE tool. Addresses may be expressed as a hex or bech32 address",
            similes: [],
            validate: async () => true,
            examples: [
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Tell me the balance of account 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e",
                            action: "GET_BALANCE",
                        },
                    },
                    {
                        user: "{{agentName}}",
                        content: {
                            text: "The balance of account 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e is 2.01 zil",
                            action: "GET_BALANCE",
                        },
                    },
                ],
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Tell me the balance of the account zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g",
                        },
                    },
                    {
                        user: "{{agentName}}",
                        content: {
                            text: "The balance of account zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g is 18.05 zil",
                            action: "GET_BALANCE",
                        },
                    },
                ],
            ],
        },
        {
            name: "CONVERT",
            description:
                "Convert address formats from bech32 to hex using the CONVERT_FROM_BECH32 tool or from hex to bech32 using the CONVERT_TO_BECH32 tool. The addresses to be converted may be either evm or zilliqa",
            similes: [],
            validate: async () => true,
            examples: [
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Convert 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e to bech32",
                        },
                    },
                    {
                        user: "{{agentName}}",
                        content: {
                            text: "The bech32 address for 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e is zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g",
                            action: "CONVERT",
                        },
                    },
                ],
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Convert zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g to hex",
                        },
                    },
                    {
                        user: "{{agentName}}",
                        content: {
                            text: "The hex address for zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g is 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e",
                            action: "CONVERT",
                        },
                    },
                ],
            ],
        },
        {
            name: "TRANSFER",
            description:
                "Transfer funds from a Zilliqa address using TRANSFER_FROM_ZILLIQA_ADDRESS or from an EVM address using TRANSFER_FROM_EVM_ADDRESS. Addresses may be in either bech32 or hex format. Both kinds of transfer return the transaction id in hex.",
            similes: [],
            validate: async () => true,
            examples: [
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Transfer 2 ZIL from the EVM address zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g to 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e",
                            action: "TRANSFER",
                        },
                    },
                ],
                [
                    {
                        user: "{{user1}}",
                        content: {
                            text: "Transfer 2 ZIL from the Zilliqa address zil17r9jftrxhfeht0umn386j83q3k0240fwn7g70g to 0xf0cb24ac66ba7375bf9b9c4fa91e208d9eaabd2e",
                            action: "TRANSFER",
                        },
                    },
                ],
            ],
        },
        // 1. Add your actions here
    ];

    const tools = await getOnChainTools({
        wallet: evmWallet,
        // 2. Configure the plugins you need to perform those actions
        plugins: [sendETH()],
    });

    const zilTools = await getOnChainTools({
        wallet: zilliqaWallet,
        plugins: [zilliqa()],
    });

    const allTools = { ...zilTools, ...tools };
    // 3. Let GOAT handle all the actions
    return actionsWithoutHandler.map((action) => ({
        ...action,
        handler: getActionHandler(action.name, action.description, allTools),
    }));
}

function getActionHandler(
    actionName: string,
    actionDescription: string,
    tools
) {
    return async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State | undefined,
        options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        let currentState = state ?? (await runtime.composeState(message));
        currentState = await runtime.updateRecentMessageState(currentState);

        try {
            // 1. Call the tools needed
            const context = composeActionContext(
                actionName,
                actionDescription,
                currentState
            );
            const result = await generateText({
                runtime,
                context,
                tools,
                maxSteps: 10,
                // Uncomment to see the log each tool call when debugging
                onStepFinish: (step) => {
                    console.log(step.toolResults);
                },
                modelClass: ModelClass.LARGE,
            });

            // 2. Compose the response
            const response = composeResponseContext(result, currentState);
            const responseText = await generateResponse(runtime, response);

            callback?.({
                text: responseText,
                content: {},
            });
            return true;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);

            // 3. Compose the error response
            const errorResponse = composeErrorResponseContext(
                errorMessage,
                currentState
            );
            const errorResponseText = await generateResponse(
                runtime,
                errorResponse
            );

            callback?.({
                text: errorResponseText,
                content: { error: errorMessage },
            });
            return false;
        }
    };
}

function composeActionContext(
    actionName: string,
    actionDescription: string,
    state: State
): string {
    const actionTemplate = `
# Knowledge
{{knowledge}}

About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}


# Action: ${actionName}
${actionDescription}

{{recentMessages}}

Based on the action chosen and the previous messages, execute the action and respond to the user using the tools you were given.
`;
    return composeContext({ state, template: actionTemplate });
}

function composeResponseContext(result: unknown, state: State): string {
    const responseTemplate = `
    # Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

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

Here is the result:
${JSON.stringify(result)}

{{actions}}

Respond to the message knowing that the action was successful and these were the previous messages:
{{recentMessages}}
  `;
    return composeContext({ state, template: responseTemplate });
}

function composeErrorResponseContext(
    errorMessage: string,
    state: State
): string {
    const errorResponseTemplate = `
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

{{actions}}

Respond to the message knowing that the action failed.
The error was:
${errorMessage}

These were the previous messages:
{{recentMessages}}
    `;
    return composeContext({ state, template: errorResponseTemplate });
}

async function generateResponse(
    runtime: IAgentRuntime,
    context: string
): Promise<string> {
    return generateText({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    });
}
