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
                name: "{{name1}}",
                content: {
                    text: "{{agentName}} show me agent positions",
                },
            },
            {
                name: "{{name2}}",
                content: {
                    text: "<NONE>",
                    actions: ["TRUST_GET_AGENT_POSITIONS"],
                },
            },
        ],
        [
            {
                name: "{{name1}}",
                content: {
                    text: "{{agentName}} show me all positions",
                },
            },
            {
                name: "{{name2}}",
                content: {
                    text: "<NONE>",
                    actions: ["TRUST_GET_AGENT_POSITIONS"],
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

        const tradingService = runtime.getService(ServiceTypes.COMMUNITY_INVESTOR);

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
                    entityId: message.entityId,
                    agentId: message.agentId,
                    roomId: message.roomId,
                    metadata: {
                        ...message.metadata,
                        actions: ["TRUST_GET_AGENT_POSITIONS"],
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
                    entityId: message.entityId,
                    agentId: message.agentId,
                    roomId: message.roomId,
                    metadata: {
                        ...message.metadata,
                        actions: ["TRUST_GET_AGENT_POSITIONS"],
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
        if (message.agentId === message.entityId) return false;
        return true;
    },
};
