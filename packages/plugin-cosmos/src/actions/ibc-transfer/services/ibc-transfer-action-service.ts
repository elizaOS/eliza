import {
    convertDisplayUnitToBaseUnit,
    getAssetBySymbol,
    getChainByChainName,
} from "@chain-registry/utils";
import { assets, chains } from "chain-registry";
import type {
    IDenomProvider,
    ICosmosActionService,
    ICosmosPluginCustomChainData,
    ICosmosTransaction,
    ICosmosWalletChains,
} from "../../../shared/interfaces.ts";
import { getAvailableAssets } from "../../../shared/helpers/cosmos-assets.ts";
import type { IBCTransferActionParams } from "../types.ts";

export class IBCTransferAction implements ICosmosActionService {
    constructor(private cosmosWalletChains: ICosmosWalletChains) {
        this.cosmosWalletChains = cosmosWalletChains;
    }

    async execute(
        params: IBCTransferActionParams,
        bridgeDenomProvider: IDenomProvider,
        customChainAssets?: ICosmosPluginCustomChainData["assets"][]
    ): Promise<ICosmosTransaction> {
        const senderAddress = await this.cosmosWalletChains.getWalletAddress(
            params.chainName
        );

        const skipClient = this.cosmosWalletChains.getSkipClient(
            params.chainName
        );

        if (!senderAddress) {
            throw new Error(
                `Cannot get wallet address for chain ${params.chainName}`
            );
        }

        if (!params.toAddress) {
            throw new Error("No receiver address");
        }

        if (!params.targetChainName) {
            throw new Error("No target chain name");
        }

        if (!params.chainName) {
            throw new Error("No chain name");
        }

        if (!params.symbol) {
            throw new Error("No symbol");
        }

        const availableAssets = getAvailableAssets(assets, customChainAssets);

        const denom = getAssetBySymbol(
            availableAssets,
            params.symbol,
            params.chainName
        );

        const sourceChain = getChainByChainName(chains, params.chainName);
        const destChain = getChainByChainName(chains, params.targetChainName);

        if (!denom.base) {
            throw new Error("Cannot find asset");
        }

        if (!sourceChain) {
            throw new Error("Cannot find source chain");
        }

        if (!destChain) {
            throw new Error("Cannot find destination chain");
        }

        const bridgeDenomResult = await bridgeDenomProvider(
            denom.base,
            sourceChain.chain_id,
            destChain.chain_id
        );

        if (!bridgeDenomResult || !bridgeDenomResult.denom) {
            throw new Error("Failed to get destination asset denomination");
        }

        const destAssetDenom = bridgeDenomResult.denom;

        const route = await skipClient.route({
            destAssetChainID: destChain.chain_id,
            destAssetDenom,
            sourceAssetChainID: sourceChain.chain_id,
            sourceAssetDenom: denom.base,
            amountIn: convertDisplayUnitToBaseUnit(
                availableAssets,
                params.symbol,
                params.amount,
                params.chainName
            ),
            cumulativeAffiliateFeeBPS: "0",
        });
        const fromAddress = {
            chainID: sourceChain.chain_id,
            address: await this.cosmosWalletChains.getWalletAddress(params.chainName)
        };

        const toAddress = {
            chainID: destChain.chain_id,
            address: params.toAddress
        };

        const userAddresses = [fromAddress, toAddress];

        let txHash: string | undefined;

        try {
            await skipClient.executeRoute({
                route,
                userAddresses,
                onTransactionCompleted: async (_, executeRouteTxHash) => {
                    txHash = executeRouteTxHash;
                },
            });
        } catch (error) {
            throw new Error(`Failed to execute route: ${error?.message}`);
        }

        if (!txHash) {
            throw new Error("Transaction hash is undefined after executing route");
        }

        return {
            from: senderAddress,
            to: params.toAddress,
            txHash,
        };
    }
}
