import {
    composeContext,
    generateObjectDeprecated,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
} from "@elizaos/core";
import { initWalletChainsData } from "../../providers/wallet/utils";
import {
    cosmosIBCTransferTemplate,
    cosmosTransferTemplate,
} from "../../templates";
import type {
    ICosmosPluginOptions,
    ICosmosWalletChains,
} from "../../shared/interfaces";
import type { IBCTransferActionParams } from "./types";
import { IBCTransferAction } from "./services/ibc-transfer-action-service";
import { bridgeDenomProvider } from "./services/bridge-denom-provider";

export const createIBCTransferAction = (
    pluginOptions: ICosmosPluginOptions
) => ({
    name: "COSMOS_IBC_TRANSFER",
    description: "Transfer tokens between addresses on cosmos chains",
    handler: async (
        _runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        _callback?: HandlerCallback
    ) => {
        const cosmosIBCTransferContext = composeContext({
            state: state,
            template: cosmosIBCTransferTemplate,
            templatingEngine: "handlebars",
        });

        const cosmosIBCTransferContent = await generateObjectDeprecated({
            runtime: _runtime,
            context: cosmosIBCTransferContext,
            modelClass: ModelClass.SMALL,
        });

        const paramOptions: IBCTransferActionParams = {
            chainName: cosmosIBCTransferContent.chainName,
            symbol: cosmosIBCTransferContent.symbol,
            amount: cosmosIBCTransferContent.amount,
            toAddress: cosmosIBCTransferContent.toAddress,
            targetChainName: cosmosIBCTransferContent.targetChainName,
        };

        try {
            const walletProvider: ICosmosWalletChains =
                await initWalletChainsData(_runtime);

            const action = new IBCTransferAction(walletProvider);

            const customAssets = (pluginOptions?.customChainData ?? []).map(
                (chainData) => chainData.assets
            );

            const transferResp = await action.execute(
                paramOptions,
                bridgeDenomProvider,
                customAssets
            );

            if (_callback) {
                await _callback({
                    text: `Successfully transferred ${paramOptions.amount} tokens from ${paramOptions.chainName} to ${paramOptions.toAddress} on ${paramOptions.targetChainName}\nTransaction Hash: ${transferResp.txHash}`,
                    content: {
                        success: true,
                        hash: transferResp.txHash,
                        amount: paramOptions.amount,
                        recipient: transferResp.to,
                        fromChain: paramOptions.chainName,
                        toChain: paramOptions.targetChainName,
                    },
                });

                const newMemory: Memory = {
                    userId: _message.agentId,
                    agentId: _message.agentId,
                    roomId: _message.roomId,
                    content: {
                        text: `Transaction ${paramOptions.amount} ${paramOptions.symbol} to address ${paramOptions.toAddress} from chain ${paramOptions.chainName} to ${paramOptions.targetChainName} was successfully transferred. Tx hash: ${transferResp.txHash}`,
                    },
                };

                await _runtime.messageManager.createMemory(newMemory);
            }
            return true;
        } catch (error) {
            console.error("Error during ibc token transfer:", error);

            if (_callback) {
                await _callback({
                    text: `Error ibc transferring tokens: ${error.message}`,
                    content: { error: error.message },
                });
            }

            const newMemory: Memory = {
                userId: _message.agentId,
                agentId: _message.agentId,
                roomId: _message.roomId,
                content: {
                    text: `Transaction ${paramOptions.amount} ${paramOptions.symbol} to address ${paramOptions.toAddress} on chain ${paramOptions.chainName} to ${paramOptions.targetChainName} was unsuccessful.`,
                },
            };

            await _runtime.messageManager.createMemory(newMemory);

            return false;
        }
    },
    template: cosmosTransferTemplate,
    validate: async (runtime: IAgentRuntime) => {
        const mnemonic = runtime.getSetting("COSMOS_RECOVERY_PHRASE");
        const availableChains = runtime.getSetting("COSMOS_AVAILABLE_CHAINS");
        const availableChainsArray = availableChains?.split(",");

        return !!(mnemonic && availableChains && availableChainsArray.length);
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Make an IBC transfer {{0.0001 ATOM}} to {{osmosis1pcnw46km8m5amvf7jlk2ks5std75k73aralhcf}} from {{cosmoshub}} to {{osmosis}}",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Do you confirm the IBC transfer action?",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Yes",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send {{50 OSMO}} to {{juno13248w8dtnn07sxc3gq4l3ts4rvfyat6f4qkdd6}} from {{osmosis}} to {{juno}}",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Do you confirm the IBC transfer action?",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Yes",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Transfer {{0.005 JUNO}} from {{juno}} to {{cosmos1n0xv7z2pkl4eppnm7g2rqhe2q8q6v69h7w93fc}} on {{cosmoshub}}",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Do you confirm the IBC transfer action?",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user1}}",
                content: {
                    text: "Yes",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "",
                    action: "COSMOS_IBC_TRANSFER",
                },
            },
        ],
    ],
    similes: [
        "COSMOS_BRIDGE_TOKEN",
        "COSMOS_IBC_SEND_TOKEN",
        "COSMOS_TOKEN_IBC_TRANSFER",
        "COSMOS_MOVE_IBC_TOKENS",
    ],
});
