import {
    type ActionExample,
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
import { ethers } from "ethers";
import { ethstorageConfig } from "../environment";
import { BlobUploader } from "../utils/uploader";
import { encodeOpBlobs } from "../utils/blobs.ts";

export const EthStorageAbi: readonly string[] = [
    'function putBlobs(bytes32[] memory _keys, uint256[] memory _blobIdxs, uint256[] memory _lengths)',
    'function putBlob(bytes32 _key, uint256 _blobIdx, uint256 _length) public payable',
    'function get(bytes32 _key, uint8 _decodeType, uint256 _off, uint256 _len) public view returns (bytes memory)',
    'function size(bytes32 _key) public view returns (uint256)',
    'function upfrontPayment() public view returns (uint256)'
];

export function stringToHex(s: string): string {
    return ethers.hexlify(ethers.toUtf8Bytes(s));
}

export async function sendData(
    RPC: string, privateKey: string,
    address: string, key: string, data: Buffer
): Promise<string> {
    const blobUploader = await BlobUploader.create(RPC, privateKey);
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(address, EthStorageAbi, wallet);
    const hexKey = ethers.keccak256(stringToHex(key));
    const storageCost = await contract.upfrontPayment();
    const tx = await contract.putBlob.populateTransaction(hexKey, 0, data.length, {
        value: storageCost,
    });

    const blobs = encodeOpBlobs(data);
    const txRes = await blobUploader.sendTx(tx, blobs);
    elizaLogger.log(`tx hash ${txRes.hash}`);
    const receipt = await txRes.wait();
    return receipt?.status === 1 ? txRes.hash : undefined;
}

const submitDataTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.


Example response:
\`\`\`json
{
    "key": "data_key"
    "data": "Hello World, this is the data I submitted",
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the requested EthStorage data submission:
- Key of the data to be submitted
- Data to be submitted

Respond with a JSON markdown block containing only the extracted values.`;

export default {
    name: "UPLOAD_DATA",
    similes: [
        "UPLOAD_DATA_TO_ETHSTORAGE",
        "SUBMIT_DATA",
        "SUBMIT_DATA_TO_ETHSTORAGE",
        "SEND_DATA",
        "SEND_DATA_TO_ETHSTORAGE",
        "POST_DATA",
        "POST_DATA_TO_ETHSTORAGE",
        "POST_DATA_ON_ETHSTORAGE_NETWORK",
        "POST_DATA_TO_ETHSTORAGE_NETWORK",
        "SEND_DATA_ON_ETHSTORAGE_NETWORK",
        "SEND_DATA_TO_ETHSTORAGE_NETWORK",
        "SUBMIT_DATA_ON_ETHSTORAGE_NETWORK",
        "SUBMIT_DATA_TO_ETHSTORAGE_NETWORK",
        "UPLOAD_DATA_ON_ETHSTORAGE_NETWORK",
        "UPLOAD_DATA_TO_ETHSTORAGE_NETWORK",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        await ethstorageConfig(runtime);
        return true;
    },
    description: "Submit data to EthStorage as per user command",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting SUBMIT_DATA handler...");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Compose transfer context
        const submitDataContext = composeContext({
            state: currentState,
            template: submitDataTemplate,
        });

        // Generate transfer content
        const content = await generateObjectDeprecated({
            runtime,
            context: submitDataContext,
            modelClass: ModelClass.SMALL,
        });

        if (content.data != null && content.key !== "") {
            try {
                const RPC = runtime.getSetting("ETHSTORAGE_RPC_URL");
                const privateKey = runtime.getSetting("ETHSTORAGE_PRIVATE_KEY");
                if (!privateKey) {
                    throw new Error("Missing ETHSTORAGE_PRIVATE_KEY");
                }
                const address = runtime.getSetting("ETHSTORAGE_ADDRESS");

                elizaLogger.log(`Transaction Data is ${content.data}`);
                const data = Buffer.from(content.data);

                //submit data
                const hash= await sendData(RPC, privateKey, address, content.key, data);
                if (hash) {
                    elizaLogger.success(
                        `Data submitted! \n Tx Hash: ${hash}`
                    );
                    if (callback) {
                        await callback({
                            text: `Data submitted! \n Tx Hash: ${hash}`,
                            content: {},
                        });
                    }
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
                    text: "Submit the following data using the key 'data_key' to EthStorage 'Hello World!'",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send the data 'Hello World!' using the key 'data_key' to EthStorage now.",
                    action: "SUBMIT_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully submitted the data 'Hello World!' using the key 'data_key' to EthStorage \nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Submit 'Don't Fight, Unite!' to EthStorage using the key 'my_key'",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll send the data 'Don't Fight, Unite!' to EthStorage using the key 'my_key' now.",
                    action: "SUBMIT_DATA",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Successfully submitted the data 'Don't Fight, Unite!' using the key 'my_key' to EthStorage \nTransaction: 0x748057951ff79cea6de0e13b2ef70a1e9f443e9c83ed90e5601f8b45144a4ed4",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
