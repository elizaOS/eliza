import type {
    IAgentRuntime,
    Memory
} from "@elizaos/core";
import { formatFullReport } from "../reports";
import { ServiceTypes, type TokenPerformance, type Transaction } from "../types";

export const getAgentPositions: any = {
    name: "TRUST_GET_AGENT_POSITIONS",
    description:
        "Retrieves and formats position data for the agent's portfolio",
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{agentName}} show me agent positions",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "<NONE>",
                    action: "TRUST_GET_AGENT_POSITIONS",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "{{agentName}} show me all positions",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "<NONE>",
                    action: "TRUST_GET_AGENT_POSITIONS",
                },
            },
        ],
    ],
    similes: ["GET_AGENT_POSITIONS", "SHOW_AGENT_PORTFOLIO"],

    async handler(
        runtime,
        message,
        _state,
        _options,
        callback: (memory: Memory) => Promise<Memory>
    ) {
        console.log("getAgentPositions is running");

        const tradingService = runtime.getService(ServiceTypes.TRUST_TRADING);

        try {
            const positions = await tradingService.getOpenPositionsWithBalance();

            const filteredPositions = positions.filter(
                (pos) => pos.isSimulation === false
            );

            if (filteredPositions.length === 0 && callback) {
                const responseMemory: Memory = {
                    content: {
                        text: "No open positions found.",
                        inReplyTo: message.id
                            ? message.id
                            : undefined,
                    },
                    userId: message.userId,
                    agentId: message.agentId,
                    roomId: message.roomId,
                    metadata: {
                        ...message.metadata,
                        action: "TRUST_GET_AGENT_POSITIONS",
                    },
                    createdAt: Date.now() * 1000,
                };
                await callback(responseMemory);
                return;
            }

            const positionIds = filteredPositions.map((p) => p.id);
            const transactions = await tradingService.getPositionsTransactions(positionIds);
            
            const tokens: TokenPerformance[] = [];

            const tokenSet = new Set<string>();
            for (const position of filteredPositions) {
                if (tokenSet.has(`${position.chain}:${position.tokenAddress}`))
                    continue;

                const tokenPerformance = await tradingService.getTokenPerformance(
                    position.chain,
                    position.tokenAddress
                );

                if (tokenPerformance) tokens.push(tokenPerformance);

                tokenSet.add(`${position.chain}:${position.tokenAddress}`);
            }

            const {
                positionReports,
                tokenReports,
                totalCurrentValue,
                totalPnL,
                totalRealizedPnL,
                totalUnrealizedPnL,
                positionsWithBalance,
            } = formatFullReport(tokens, filteredPositions, transactions as unknown as Transaction[]);

            if (callback) {
                const formattedPositions = positionsWithBalance
                    .map(({ position, token, transactions }) => {
                        const _latestTx = transactions[transactions.length - 1];
                        const currentValue = token.price
                            ? (
                                  Number(position.balance) * token.price
                              ).toString()
                            : "0";
                        console.log("Calculated current value:", currentValue);
                        const pnlPercent =
                            token.price && position.initialPrice
                                ? (
                                      ((Number(token.price) -
                                          Number(position.initialPrice)) /
                                          Number(position.initialPrice)) *
                                      100
                                  ).toFixed(2)
                                : "0";

                        return (
                            `**${token.symbol} (${token.name})**\n` +
                            `Address: ${token.address}\n` +
                            `Price: $${token.price}\n` +
                            `Value: $${currentValue}\n` +
                            `P&L: ${pnlPercent}%\n`
                        );
                    })
                    .join("\n\n");

                const summary =
                    `💰 **Agent Portfolio Summary**\nTotal Value: ${totalCurrentValue}\nTotal P&L: ${totalPnL}\nRealized: ${totalRealizedPnL}\nUnrealized: ${totalUnrealizedPnL}`;

                await callback({
                    content: {
                        text:
                            positionsWithBalance.length > 0
                                ? `${summary}\n\n${formattedPositions}`
                                : "No open positions found.",
                        inReplyTo: message.id
                            ? message.id
                            : undefined,
                    },
                    userId: message.userId,
                    agentId: message.agentId,
                    roomId: message.roomId,
                    metadata: {
                        ...message.metadata,
                        action: "TRUST_GET_AGENT_POSITIONS",
                    },
                    createdAt: Date.now() * 1000,
                });
            }
        } catch (error) {
            console.error("Error in getPositions:", error);
            throw error;
        }
    },

    async validate(_runtime: IAgentRuntime, message: Memory) {
        if (message.agentId === message.userId) return false;
        return true;
    },
};
