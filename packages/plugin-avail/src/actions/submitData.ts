import {
    type ActionExample,
    type Content,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
    type Action,
    elizaLogger,
    composeContext,
    generateObjectDeprecated,
} from "@elizaos/core";
import { validateAvailConfig } from "../environment";
import {
    //getDecimals,
    initialize,
    getKeyringFromSeed,
} from "avail-js-sdk";
import type { H256 } from "@polkadot/types/interfaces/runtime";
import { ISubmittableResult } from "@polkadot/types/types";

export interface DataContent extends Content {
    data: string;
}

export function isDataContent(content: DataContent): content is DataContent {
    // Validate types
    const validTypes = typeof content.data === "string";
    if (!validTypes) {
        return false;
    }
}

const submitDataTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.


Example response:
\`\`\`json
{
    "data": "Hello World, this is the data I submitted"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested AVAIL token transfer:
- Data to be submitted

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "SUBMIT_DATA",
    similes: [
        "SUBMIT_DATA_TO_AVAIL",
        "SEND_DATA",
        "SEND_DATA_TO_AVAIL",
        "POST_DATA",
        "POST_DATA_TO_AVAIL",
        "POST_DATA_ON_AVAIL_NETWORK",
        "POST_DATA_TO_AVAIL_NETWORK",
        "SEND_DATA_ON_AVAIL_NETWORK",
        "SEND_DATA_TO_AVAIL_NETWORK",
        "SUBMIT_DATA_ON_AVAIL_NETWORK",
        "SUBMIT_DATA_TO_AVAIL_NETWORK",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await validateAvailConfig(runtime);
        return true;
    },
    description: "Submit data to Avail as per user command",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SUBMIT_DATA handler...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose transfer context
        const submitDataContext = composeContext({
            state,
            template: submitDataTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: submitDataContext,
            modelClass: ModelClass.SMALL,
        });

        // Validate transfer content
        // if (!isDataContent(content)) {
        //     console.log(content + typeof(content.data))
        //     console.error("Invalid content for SUBMIT_DATA action.");
        //     if (callback) {
        //         callback({
        //             text: "Unable to process submit data request. Invalid content provided.",
        //             content: { error: "Invalid data content" },
        //         });
        //     }
        //     return false;
        // }
        if (content.data != null) {
            try {
                const SEED = runtime.getSetting("AVAIL_SEED")!;
                //const ACCOUNT = runtime.getSetting("AVAIL_ADDRESS")!;
                const ENDPOINT = runtime.getSetting("AVAIL_RPC_URL");
                const APP_ID = runtime.getSetting("AVAIL_APP_ID");

                const api = await initialize(ENDPOINT);
                const keyring = getKeyringFromSeed(SEED);
                const options = { app_id: APP_ID, nonce: -1 };
                //const decimals = getDecimals(api);
                const data = content.data;

                const submitDataInfo = await api.tx.dataAvailability
                    .submitData(data)
                    .paymentInfo(keyring);
                //print estimated fees
                elizaLogger.log(`Transaction Fee for Submit Data:
            class=${submitDataInfo.class.toString()},
            weight=${submitDataInfo.weight.toString()},
            partialFee=${submitDataInfo.partialFee.toHuman()}
          `);

                //submit data
                const txResult:ISubmittableResult = await new Promise(
                    (res) => {
                        api.tx.dataAvailability
                            .submitData(data)
                            .signAndSend(
                                keyring,
                                options,
                                (result) => {
                                    elizaLogger.log(
                                        `Tx status: ${result.status}`
                                    );
                                    if (result.isFinalized || result.isError) {
                                        res(result as any);
                                    }
                                }
                            );
                    }
                );

                // Rejected Transaction handling
                if (txResult.isError) {
                    console.log(`Transaction was not executed`);
                }

                // Failed Transaction handling
                const error = txResult.dispatchError;
                if (error != undefined) {
                    if (error.isModule) {
                        const decoded = api.registry.findMetaError(
                            error.asModule
                        );
                        const { docs, name, section } = decoded;
                        console.log(`${section}.${name}: ${docs.join(" ")}`);
                    } else {
                        console.log(error.toString());
                    }
                }

                elizaLogger.success(
                    "Data submitted successfully! tx: \n " +
                        `Tx Hash: ${txResult.txHash as H256}, Block Hash: ${txResult.status.asFinalized as H256}`
                );
                if (callback) {
                    callback({
                        text: `Data submitted successfully! tx hash: ${txResult.txHash as H256} Block Hash: ${txResult.status.asFinalized as H256} `,
                        content: {},
                    });
                }

                return true;
            } catch (error) {
                elizaLogger.error("Error during data submission:", error);
                if (callback) {
                    callback({
                        text: `Error submitting data: ${error.message}`,
                        content: { error: error.message },
                    });
                }
                return false;
            }
        } else {
            elizaLogger.log("No data mentioned to be submitted");
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Submit the following data to Avail 'Hello World!'",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send the data 'Hello World!' to Avail now.",
                    action: "SUBMIT_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully submitted the data 'Hello World!' to Avail \nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Submit 'Don't Fight, Unite!' to Avail",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send the data 'Don't Fight, Unite!' to Avail now.",
                    action: "SUBMIT_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully submitted the data 'Don't Fight, Unite!' to Avail \nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
