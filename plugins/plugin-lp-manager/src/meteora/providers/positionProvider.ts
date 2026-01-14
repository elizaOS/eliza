import { elizaLogger, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { DLMM } from '../utils/dlmm.ts';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadWallet } from '../utils/loadWallet.ts';

export interface MeteoraPositionStatistics {
    poolAddress: string;
    positionPubKey: string;
    inRange: boolean;
    distanceFromActiveBinBps: number;
    binRange: number;
}

export const meteoraPositionProvider: Provider = {
    name: 'degen-lp-meteora-position-provider',
    description: 'Provides Meteora LP position information for the current wallet',
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        }

        try {
            const { address: ownerAddress, connection } = await loadWallet(runtime, false);
            if (!ownerAddress) {
                elizaLogger.error('Could not load wallet address');
                return {
                    data: {
                        positions: [],
                        error: 'No wallet address found',
                    },
                    values: {
                        positionCount: 0,
                        hasPositions: false,
                    },
                    text: 'No wallet address found. Unable to fetch Meteora positions.',
                };
            }
            
            const positions = await fetchPositions(connection, ownerAddress);
            const positionCount = positions.length;
            const inRangeCount = positions.filter(p => p.inRange).length;
            
            let positionText = '';
            if (positionCount === 0) {
                positionText = 'No Meteora LP positions found.';
            } else {
                positionText = `Found ${positionCount} Meteora LP position${positionCount > 1 ? 's' : ''}. ${inRangeCount} ${inRangeCount === 1 ? 'is' : 'are'} currently in range.`;
                
                // Add details for each position
                positions.forEach((pos, index) => {
                    positionText += `\n\nPosition ${index + 1}:`;
                    positionText += `\n- Pool: ${pos.poolAddress.slice(0, 8)}...`;
                    positionText += `\n- In Range: ${pos.inRange ? 'Yes' : 'No'}`;
                    positionText += `\n- Distance from Active Bin: ${pos.distanceFromActiveBinBps} bps`;
                    positionText += `\n- Bin Range: ${pos.binRange}`;
                });
            }
            
            return {
                data: {
                    positions,
                    positionCount,
                    inRangeCount,
                },
                values: {
                    positionCount,
                    hasPositions: positionCount > 0,
                    inRangeCount,
                },
                text: positionText,
            };
        } catch (error) {
            elizaLogger.error('Error in Meteora position provider:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return {
                data: {
                    positions: [],
                    error: errorMessage,
                },
                values: {
                    positionCount: 0,
                    hasPositions: false,
                },
                text: `Error fetching Meteora positions: ${errorMessage}`,
            };
        }
    },
};

const fetchPositions = async (
    connection: Connection,
    ownerAddress: PublicKey
): Promise<MeteoraPositionStatistics[]> => {
    try {
        // TODO: This should be fetched from a dynamic source, e.g. the Meteora API
        const POOL_ADDRESSES = [
            'ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq' // USDC/USDT
        ];

        const positions: MeteoraPositionStatistics[] = [];

        for (const poolAddress of POOL_ADDRESSES) {
            const dlmmPool = await DLMM.create(connection as any, new PublicKey(poolAddress));
            const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerAddress);
            const activeBin = await dlmmPool.getActiveBin();

            for (const position of userPositions) {
                const binData = position.positionData.positionBinData;
                const positionBinIds = binData.map((b: { binId: number }) => b.binId);
                const binRange = Math.max(...positionBinIds) - Math.min(...positionBinIds);

                const centerBinId = Math.floor(
                    (Math.max(...positionBinIds) + Math.min(...positionBinIds)) / 2
                );

                const distanceFromActiveBinBps = Math.abs(centerBinId - activeBin.binId) * 100;

                positions.push({
                    poolAddress: poolAddress.toString(),
                    positionPubKey: position.publicKey.toString(),
                    inRange: positionBinIds.includes(activeBin.binId),
                    distanceFromActiveBinBps,
                    binRange,
                });
            }
        }

        return positions;
    } catch (error) {
        throw new Error(`Error fetching Meteora positions: ${error}`);
    }
};
