import { elizaLogger, IAgentRuntime, Memory, Provider, settings, State } from "@elizaos/core";
import { createSolanaRpc } from "@solana/web3.js";
import { loadWallet } from "../../utils/loadWallet";
import { Address, Rpc, SolanaRpcApi } from "@solana/web3.js";
import { fetchPositionsForOwner, HydratedPosition } from "@orca-so/whirlpools"
import { fetchWhirlpool, Whirlpool } from "@orca-so/whirlpools-client";
import { sqrtPriceToPrice, tickIndexToPrice } from "@orca-so/whirlpools-core";
import { fetchMint, Mint } from "@solana-program/token-2022"

export interface FetchedPositionStatistics {
    whirlpoolAddress: Address;
    positionMint: Address;
    inRange: boolean;
    distanceCenterPositionFromPoolPriceBps: number;
    positionWidthBps: number;
}

export const positionProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        try {
            const { address: ownerAddress } = await loadWallet(
                runtime,
                false
            );
            const rpc = createSolanaRpc(settings.SOLANA_RPC_URL!);
            const positions = await fetchPositions(rpc, ownerAddress);
            const positionsString = JSON.stringify(positions);
            return positionsString
        } catch (error) {
            elizaLogger.error("Error in wallet provider:", error);
            return null;
        }
    },
};

const fetchPositions = async (rpc: Rpc<SolanaRpcApi>, ownerAddress: Address): Promise<FetchedPositionStatistics[]> => {
    try {
        const positions = await fetchPositionsForOwner(rpc, ownerAddress);
        const fetchedWhirlpools: Map<string, Whirlpool> = new Map();
        const fetchedMints: Map<string, Mint> = new Map();
        const FetchedPositionsStatistics: FetchedPositionStatistics[] = await Promise.all(positions.map(async (position) => {
            const positionData = (position as HydratedPosition).data;
            const positionMint = positionData.positionMint
            const whirlpoolAddress = positionData.whirlpool;
            if (!fetchedWhirlpools.has(whirlpoolAddress)) {
                const whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
                if (whirlpool) {
                    fetchedWhirlpools.set(whirlpoolAddress, whirlpool.data);
                }
            }
            const whirlpool = fetchedWhirlpools.get(whirlpoolAddress);
            const { tokenMintA, tokenMintB } = whirlpool;
            if (!fetchedMints.has(tokenMintA)) {
                const mintA = await fetchMint(rpc, tokenMintA);
                fetchedMints.set(tokenMintA, mintA.data);
            }
            if (!fetchedMints.has(tokenMintB)) {
                const mintB = await fetchMint(rpc, tokenMintB);
                fetchedMints.set(tokenMintB, mintB.data);
            }
            const mintA = fetchedMints.get(tokenMintA);
            const mintB = fetchedMints.get(tokenMintB);
            const currentPrice = sqrtPriceToPrice(whirlpool.sqrtPrice, mintA.decimals, mintB.decimals);
            const positionLowerPrice = tickIndexToPrice(positionData.tickLowerIndex, mintA.decimals, mintB.decimals);
            const positionUpperPrice = tickIndexToPrice(positionData.tickUpperIndex, mintA.decimals, mintB.decimals);

            const inRange = whirlpool.tickCurrentIndex >= positionData.tickLowerIndex && whirlpool.tickCurrentIndex <= positionData.tickUpperIndex;
            const positionCenterPrice = (positionLowerPrice + positionUpperPrice) / 2;
            const distanceCenterPositionFromPoolPriceBps = Math.abs(currentPrice - positionCenterPrice) / currentPrice * 10000;
            const positionWidthBps = ((positionUpperPrice - positionLowerPrice) / positionCenterPrice * 10000) / 2;

            return {
                whirlpoolAddress,
                positionMint: positionMint,
                inRange,
                distanceCenterPositionFromPoolPriceBps,
                positionWidthBps,
            } as FetchedPositionStatistics;
        }));

        return FetchedPositionsStatistics
    } catch (error) {
        throw new Error("Error during feching positions");
    }
}