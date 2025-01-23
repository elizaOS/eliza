import {assets, chains} from "chain-registry";
import {
    ICosmosActionService,
    ICosmosPluginCustomChainData,
    ICosmosSwap,
    ICosmosWalletChains,
} from "../../../shared/interfaces.ts";
import {IBCSwapActionParams} from "../types.ts";
import {
    convertDisplayUnitToBaseUnit,
    getChainByChainName,
    getChainNameByChainId,
    getDenomBySymbol,
    getExponentByDenom,
} from "@chain-registry/utils";
import {getAvailableAssets} from "../../../shared/helpers/cosmos-assets.ts";
import {HandlerCallback} from "@elizaos/core";

export class IBCSwapAction implements ICosmosActionService {
    constructor(private cosmosWalletChains: ICosmosWalletChains) {
        this.cosmosWalletChains = cosmosWalletChains;
    }

    async execute(
        params: IBCSwapActionParams,
        customChainAssets?: ICosmosPluginCustomChainData["assets"][],
        _callback?: HandlerCallback
    ): Promise<ICosmosSwap> {
        const fromChain = getChainByChainName(chains, params.fromChainName);
        if (!fromChain) {
            throw new Error(`Cannot find source chain: ${params.fromChainName}`);
        }

        const toChain = getChainByChainName(chains, params.toChainName);
        if (!toChain) {
            throw new Error(`Cannot find destination chain: ${params.toChainName}`);
        }

        const availableAssets = getAvailableAssets(assets, customChainAssets);

        const denomFrom =
            params.fromTokenDenom ||
            getDenomBySymbol(
                availableAssets,
                params.fromTokenSymbol,
                params.fromChainName
            );
        if (!denomFrom) {
            throw new Error(`Cannot find source token denom for symbol: ${params.fromTokenSymbol}`);
        }

        const exponentFrom = getExponentByDenom(
            availableAssets,
            denomFrom,
            params.fromChainName
        );

        const denomTo =
            params.toTokenDenom ||
            getDenomBySymbol(
                availableAssets,
                params.toTokenSymbol,
                params.toChainName
            );
        if (!denomTo) {
            throw new Error(`Cannot find destination token denom for symbol: ${params.toTokenSymbol}`);
        }

        console.log(
            `Swap data: Swapping token ${denomFrom} with exponent ${exponentFrom} to token ${denomTo}`
        );

        const skipClient = this.cosmosWalletChains.getSkipClient(
            params.fromChainName
        );

        const route = await skipClient.route({
            smartSwapOptions: {},
            amountOut: convertDisplayUnitToBaseUnit(
                availableAssets,
                params.fromTokenSymbol,
                params.fromTokenAmount,
                params.fromChainName
            ),
            sourceAssetDenom: denomFrom,
            sourceAssetChainID: fromChain.chain_id,
            destAssetDenom: denomTo,
            destAssetChainID: toChain.chain_id,
        });

        // Required chains must be added to env file. Note that swaps can use intermediate chains to complete the swap request
        // These chains should also be included
        const userAddresses = await Promise.all(
            route.requiredChainAddresses.map(async (chainID) => {
                const chainName = getChainNameByChainId(chains, chainID);
                return {
                    chainID,
                    address:
                        await this.cosmosWalletChains.getWalletAddress(
                            chainName
                        ),
                };
            })
        );

        if (_callback) {
            await _callback({
                text: `Expected swap result: ${route.estimatedAmountOut} ${params.toTokenSymbol}, \nEstimated Fee: ${route.estimatedFees}. \nEstimated time: ${route.estimatedRouteDurationSeconds}`,
            });
        }

        let result: ICosmosSwap;

        await skipClient.executeRoute({
            route,
            userAddresses,
            onTransactionCompleted: async (chainID, txHash, status) => {
                console.log(
                    `Route completed with tx hash: ${txHash} & status: ${status.state}`
                );

                result = {
                    status: status.state,
                    fromChainName: params.fromChainName,
                    fromTokenAmount: params.fromTokenAmount,
                    fromTokenSymbol: params.fromTokenSymbol,
                    toChainName: params.toChainName,
                    toTokenSymbol: params.toTokenSymbol,
                    txHash,
                };
            },
        });

        return result;
    }
}
