// createGenericAction.ts
import type { ActionExample } from "@elizaos/core";
import {
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    elizaLogger,
    composeContext,
    type Action,
    generateObjectDeprecated,
    generateText,
} from "@elizaos/core";
import { InjectiveGrpcClient } from "@injective/modules";

/**
 * Shape of the arguments to create our generic action.
 *
 * @property {string} name - The action name (e.g., "PLACE_BID", "CANCEL_BID").
 * @property {string} description - A brief summary of what the action does.
 * @property {unknown} template - A template object (e.g., from @injective/template/auction) used for context composition.
 * @property {any[]} examples - The example user/assistant interactions you want associated with this action.
 * @property {string} functionName - The name of the method you want to call on `InjectiveGrpcClient` (e.g. `"msgBid"`).
 * @property {(runtime: IAgentRuntime, content: any) => boolean} validateContent - Function to validate the AI-generated content.
 */
export interface CreateGenericActionArgs {
    name: string;
    similes: string[]; // (optional) synonyms or alternate names if you like
    description: string;
    template: string;
    examples: any[];
    functionName: string; // e.g. "msgBid"
    validateContent: (runtime: IAgentRuntime, content: any) => boolean;
}
/**
 * A factory function that returns an ElizaOS Action.
 */
export function createGenericAction({
    name,
    description,
    template,
    examples,
    functionName,
    similes,
}: CreateGenericActionArgs): Action {
    return {
        name, // e.g. "PLACE_BID"
        description, // e.g. "Place a bid using the InjectiveGrpcClient"
        examples: [examples as ActionExample[]], // I have manually casted the inputs here
        similes, // (optional) synonyms or alternate names if you like
        validate: async (_runtime, _message) => {
            return true;
        },

        handler: async (
            runtime: IAgentRuntime,
            message: Memory,
            state: State,
            _options: { [key: string]: unknown },
            callback?: HandlerCallback
        ): Promise<boolean> => {
            elizaLogger.debug(`create action: ${name}`);
            // 1. Compose or update the state

            let currentState = state;
            if (!currentState) {
                currentState = (await runtime.composeState(message)) as State;
            } else {
                currentState = await runtime.updateRecentMessageState(currentState);
            }
    
            
            // 2. Compose a context from the given template
            const context = composeContext({
                state: currentState,
                template,
            });

            // 3. Use the AI model to generate content based on the context
            const params = await generateObjectDeprecated({
                runtime,
                context,
                modelClass: ModelClass.LARGE,
            });

            // 5. Initialize the Injective client
            try {
                const rawNetwork = runtime.getSetting("INJECTIVE_NETWORK");
                const injectivePrivateKey = runtime.getSetting(
                    "INJECTIVE_PRIVATE_KEY"
                );
                const ethPublicKey = runtime.getSetting("EVM_PUBLIC_KEY");
                const injPublicKey = runtime.getSetting("INJECTIVE_PUBLIC_KEY");
                const network = rawNetwork as
                    | "MainnetK8s"
                    | "MainnetLB"
                    | "Mainnet"
                    | "MainnetSentry"
                    | "MainnetOld"
                    | "Staging"
                    | "Internal"
                    | "TestnetK8s"
                    | "TestnetOld"
                    | "TestnetSentry"
                    | "Testnet"
                    | "Devnet1"
                    | "Devnet2"
                    | "Devnet"
                    | "Local";
                if (
                    !injectivePrivateKey ||
                    (!ethPublicKey && !injPublicKey) ||
                    !network
                ) {
                    throw new Error("Incorrect configuration");
                }

                const client = new InjectiveGrpcClient(
                    network,
                    injectivePrivateKey,
                    ethPublicKey,
                    injPublicKey
                );

                // 6. Dynamically call the specified functionName on the Injective client
                const method = ((client as unknown) as { [key: string]: (params: unknown) => Promise<{ success: boolean; result: { code: number } }> })[functionName];
                if (typeof method !== "function") {
                    throw new Error(
                        `Method "${functionName}" does not exist on InjectiveGrpcClient`
                    );
                }
                //Function that the LLM extracted
                console.log(`wil pass these params ${JSON.stringify(params)}}`);

                //Need to standardize this context params
                const response = await method(params);
                console.log(
                    `Recieved a response from InjectiveGrpcClient , response: ${JSON.stringify(response)}, `
                );
                // Lets convert the result of the response into something that can be read
                if (response.success) {
                    console.log("Cleaning up the response");
                    const additionalTemplate = 'Extract the response from the following data, also make sure that you format the response into human readable format, make it the prettiest thing anyone can read basically a very nice comprehensive summary in a string format.';
                    const responseResult = JSON.stringify(response.result);
                    const newContext = `${additionalTemplate}\n${responseResult}`;
                    const totalContext = `Previous chat context:${context} \n New information : ${newContext}`;
                    console.log(
                        `Got context, now will pass it on to llm ${totalContext}`
                    );
                    const responseContent = await generateText({
                        runtime,
                        context: totalContext,
                        modelClass: ModelClass.SMALL,
                    });

                    console.log("Response content:", responseContent);
                    if (callback)
                        callback({
                            text: `Operation ${name} succeeded, ${responseContent}.`,
                            content: response.result,
                        });
                } else {
                    // 7. Trigger any callback with failure info
                    if (callback) {
                        callback({
                            text: `Operation ${name} failed.\n${response.result}`,
                            content: response.result,
                        });
                    }
                }

                // Return true if code == 0 (success), else false
                return response.result.code === 0;
            } catch (error) {
                if (callback) {
                    callback({
                        text: `Error in ${name}: ${(error as Error).message}`,
                        content: { error: (error as Error).message },
                    });
                }
                return false;
            }
        },
    };
}
