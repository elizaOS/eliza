import {
    MsgCreateBucket,
    MsgDeleteObject,
} from "@bnb-chain/greenfield-cosmos-types/greenfield/storage/tx";
import { createRequire } from "module";
import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    HandlerCallback,
    Media,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { readFileSync, statSync } from "fs";
import { lookup } from "mime-types";
import { extname } from "node:path";
import { InitGnfdClient } from "../providers/gnfd";
import { initWalletProvider, WalletProvider } from "../providers/wallet";
import { greenfieldTemplate } from "../templates";
import { DelegatedPubObjectRequest } from "@bnb-chain/greenfield-js-sdk";
import { SupportedChain } from "../types";
import { CROSS_CHAIN_ABI } from "../abi/CrossChainAbi";
import { TOKENHUB_ABI } from "../abi/TokenHubAbi";

export { greenfieldTemplate };

const require = createRequire(import.meta.url);
const {
    Client,
    Long,
    VisibilityType,
} = require("@bnb-chain/greenfield-js-sdk");

export class GreenfieldAction {
    constructor(
        private walletProvider: WalletProvider,
        private gnfdClient: typeof Client
    ) {}

    async getSps() {
        const sps = await this.gnfdClient.sp.getStorageProviders();

        return sps;
    }

    async selectSp() {
        const finalSps = await this.getSps();

        const selectIndex = Math.floor(Math.random() * finalSps.length);

        const secondarySpAddresses = [
            ...finalSps.slice(0, selectIndex),
            ...finalSps.slice(selectIndex + 1),
        ].map((item) => item.operatorAddress);
        const selectSpInfo = {
            id: finalSps[selectIndex].id,
            endpoint: finalSps[selectIndex].endpoint,
            primarySpAddress: finalSps[selectIndex]?.operatorAddress,
            sealAddress: finalSps[selectIndex].sealAddress,
            secondarySpAddresses,
        };

        return selectSpInfo;
    }

    async bnbTransferToGnfd(amount: bigint, chain: SupportedChain) {
        this.walletProvider.switchChain(chain);
        const publicClient = this.walletProvider.getPublicClient(chain);
        const walletClient = this.walletProvider.getWalletClient(chain);

        const config = chain === "bsc" ? CONFIG["MAINNET"] : CONFIG["TESTNET"];

        const [relayFee, ackRelayFee] = await publicClient.readContract({
            address: config.CROSSCHAIN_ADDRESS as `0x${string}`,
            abi: CROSS_CHAIN_ABI,
            functionName: "getRelayFees",
        });
        const relayerFee = relayFee + ackRelayFee;
        const totalAmount = relayerFee + amount;

        const { request } = await publicClient.simulateContract({
            account: this.walletProvider.getAccount(),
            address: config.TOKENHUB_ADDRESS as `0x${string}`,
            abi: TOKENHUB_ABI,
            functionName: "transferOut",
            args: [this.walletProvider.getAddress(), amount],
            value: totalAmount,
        });

        const hash = await walletClient.writeContract(request);
        const tx = await publicClient.waitForTransactionReceipt({
            hash,
        });

        return tx.transactionHash;
    }

    async createBucket(msg: MsgCreateBucket) {
        elizaLogger.log("create bucket...");
        const createBucketTx = await this.gnfdClient.bucket.createBucket(msg);

        const createBucketTxSimulateInfo = await createBucketTx.simulate({
            denom: "BNB",
        });

        const createBucketTxRes = await createBucketTx.broadcast({
            denom: "BNB",
            gasLimit: Number(createBucketTxSimulateInfo?.gasLimit),
            gasPrice: createBucketTxSimulateInfo?.gasPrice || "5000000000",
            payer: msg.paymentAddress,
            granter: "",
            privateKey: this.walletProvider.getPk(),
        });

        elizaLogger.log("createBucketTxRes", createBucketTxRes);

        if (createBucketTxRes.code === 0) {
            elizaLogger.log("create bucket success");
        }
        return createBucketTxRes.transactionHash;
    }

    async uploadObject(msg: DelegatedPubObjectRequest) {
        const uploadRes = await this.gnfdClient.object.delegateUploadObject(
            msg,
            {
                type: "ECDSA",
                privateKey: this.walletProvider.getPk(),
            }
        );
        if (uploadRes.code === 0) {
            elizaLogger.log("upload object success");
        }
        return uploadRes.message;
    }

    async deleteObject(msg: MsgDeleteObject) {
        const deleteObjectTx = await this.gnfdClient.object.deleteObject(msg);

        const simulateInfo = await deleteObjectTx.simulate({
            denom: "BNB",
        });

        const res = await deleteObjectTx.broadcast({
            denom: "BNB",
            gasLimit: Number(simulateInfo?.gasLimit),
            gasPrice: simulateInfo?.gasPrice || "5000000000",
            payer: msg.operator,
            granter: "",
            privateKey: this.walletProvider.getPk(),
        });

        if (res.code === 0) {
            elizaLogger.log("delete success");
        }

        return res.transactionHash;
    }
}

export const greenfieldAction = {
    name: "GREENFIELD_ACTION",
    description:
        "create bucket, upload object, delete object on the greenfield chain",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Starting Gnfd action...");

        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose context
        const context = composeContext({
            state,
            template: greenfieldTemplate,
        });
        const content = await generateObjectDeprecated({
            runtime,
            context: context,
            modelClass: ModelClass.LARGE,
        });

        elizaLogger.log("content", content);

        const gnfdClient = await InitGnfdClient(runtime);
        const walletProvider = initWalletProvider(runtime);
        const action = new GreenfieldAction(walletProvider, gnfdClient);

        let result;
        const actionType = content.actionType;
        const spInfo = await action.selectSp();

        elizaLogger.log("spInfo", spInfo);

        const { bucketName, objectName } = content;
        const attachments = message.content.attachments;

        switch (actionType) {
            case "createBucket": {
                const hash = await action.createBucket({
                    bucketName: bucketName,
                    creator: walletProvider.account.address,
                    visibility: VisibilityType.VISIBILITY_TYPE_PUBLIC_READ,
                    chargedReadQuota: Long.fromString("0"),
                    paymentAddress: walletProvider.account.address,
                    primarySpAddress: spInfo.primarySpAddress,
                });
                result = `create bucket successfully, hash: ${hash}`;
                break;
            }

            case "uploadObject": {
                if (!attachments) {
                    throw new Error("no file to upload");
                }

                const uploadObjName = objectName;

                await action.uploadObject({
                    bucketName,
                    objectName: uploadObjName,
                    body: generateFile(attachments[0]),
                    delegatedOpts: {
                        visibility: VisibilityType.VISIBILITY_TYPE_PUBLIC_READ,
                    },
                });

                if (attachments.length > 1) {
                    result += `Only one object can be uploaded. \n`;
                }
                result += `Upload object successfully, name: ${uploadObjName}`;
                break;
            }

            case "deleteObject": {
                const hash = await action.deleteObject({
                    bucketName,
                    objectName,
                    operator: walletProvider.account.address,
                });
                result = `delete object successfully, hash: ${hash}`;
                break;
            }
        }

        if (result) {
            callback?.({
                text: result,
            });
        } else {
            callback?.({
                text: `Unsuccessfully ${actionType}`,
                content: { ...result },
            });
        }

        try {
            return true;
        } catch (error) {
            elizaLogger.error("Error in get balance:", error.message);
            callback?.({
                text: `Getting balance failed`,
                content: { error: error.message },
            });
            return false;
        }
    },
    template: greenfieldTemplate,
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Create a bucket on greenfield",
                    action: "GREENFIELD_ACTION",
                },
            },
            {
                user: "user",
                content: {
                    text: "Upload a object on greenfield",
                    action: "GREENFIELD_ACTION",
                },
            },
            {
                user: "user",
                content: {
                    text: "Delete object on  greenfield",
                    action: "GREENFIELD_ACTION",
                },
            },
            {
                user: "user",
                content: {
                    text: "Transfer bnb to greenfield",
                    action: "GREENFIELD_ACTION",
                },
            },
        ],
    ],
    similes: [
        "GREENFIELD_ACTION",
        "CREATE_BUCKET",
        "UPLOAD_OBJECT",
        "DELETE_BUCKET",
        "BNB_TRANSFER_TO_GREENFIELD",
    ],
};

function generateFile(attachment: Media) {
    const filePath = fixPath(attachment.url);

    elizaLogger.log("filePath", filePath);

    const stats = statSync(filePath);
    const fileSize = stats.size;
    const name = extname(filePath);
    const type = lookup(name);

    if (!type) throw new Error(`Unsupported file type: ${filePath}`);

    return {
        name: filePath,
        type,
        size: fileSize,
        content: readFileSync(filePath),
    };
}

function fixPath(url: string) {
    return url.replace("/agent/agent/", "/agent/");
}

const CONFIG = {
    MAINNET: {
        TOKENHUB_ADDRESS: "0xeA97dF87E6c7F68C9f95A69dA79E19B834823F25",
        CROSSCHAIN_ADDRESS: "0x77e719b714be09F70D484AB81F70D02B0E182f7d",
        GREENFIELD_RPC_URL: "https://greenfield-chain.bnbchain.org",
        GREENFIELD_CHAIN_ID: "1017",
    },
    TESTNET: {
        TOKENHUB_ADDRESS: "0xED8e5C546F84442219A5a987EE1D820698528E04",
        CROSSCHAIN_ADDRESS: "0xa5B2c9194131A4E0BFaCbF9E5D6722c873159cb7",
        GREENFIELD_RPC_URL:
            "https://gnfd-testnet-fullnode-tendermint-us.bnbchain.org",
        GREENFIELD_CHAIN_ID: "5600",
    },
};
