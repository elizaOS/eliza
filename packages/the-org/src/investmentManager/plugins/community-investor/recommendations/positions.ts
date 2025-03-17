import { type Action, type IAgentRuntime, type Memory, type UUID, logger } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import { formatFullReport } from '../reports';
import type { CommunityInvestorService } from '../tradingService';
import { ServiceType, type TokenPerformance, type Transaction } from '../types';

/**
 * Action to retrieve and format position data for the agent's portfolio.
 * @type {Action}
 * @property {string} name - The name of the action, "GET_POSITIONS".
 * @property {string} description - Description of the action.
 * @property {Array<Array<Object>>} examples - Examples demonstrating how to use the action.
 * @property {Array<string>} similes - Related actions for comparison.
 * @property {Function} handler - Asynchronous function to handle the action logic.
 * @property {Function} validate - Asynchronous function to validate the action parameters.
 */
export const getPositions: Action = {
  name: 'GET_POSITIONS',
  description: "Retrieves and formats position data for the agent's portfolio",
  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: '{{agentName}} show me my positions',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '<NONE>',
          actions: ['GET_POSITIONS'],
        },
      },
    ],
  ],
  similes: ['GET_POSITIONS', 'SHOW_PORTFOLIO'],

  async handler(runtime, message, _state, _options, callback: any) {
    const tradingService = runtime.getService<CommunityInvestorService>(
      ServiceType.COMMUNITY_INVESTOR
    );

    if (!tradingService) {
      throw new Error('No trading service found');
    }

    try {
      const [positions, user] = await Promise.all([
        tradingService.getOpenPositionsWithBalance(),
        runtime.getEntityById(message.entityId),
      ]);

      if (!user) {
        logger.error('No User Found, no entity score can be generated');
        await runtime.createMemory(
          {
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: message.roomId,
            content: {
              thought: 'No user found',
              actions: ['GET_POSITIONS_FAILED'],
            },
          },
          'messages'
        );
        return;
      }

      const entity = await runtime.getEntityById(user.id);

      const filteredPositions = positions.filter(
        (pos) => pos.entityId === entity?.id && pos.isSimulation === false
      );

      if (filteredPositions.length === 0 && callback) {
        const responseMemory: Memory = {
          content: {
            text: 'No open positions found.',
            inReplyTo: message.id ? message.id : undefined,
            actions: ['GET_POSITIONS'],
          },
          entityId: message.entityId,
          agentId: message.agentId,
          metadata: message.metadata,
          roomId: message.roomId,
          createdAt: Date.now() * 1000,
        };
        await callback(responseMemory);
        return;
      }

      const transactions =
        filteredPositions.length > 0
          ? await tradingService.getPositionsTransactions(filteredPositions.map((p) => p.id))
          : [];

      const tokens: TokenPerformance[] = [];

      const tokenSet = new Set<string>();
      for (const position of filteredPositions) {
        if (tokenSet.has(`${position.chain}:${position.tokenAddress}`)) continue;

        const tokenPerformance = await tradingService.getTokenPerformance(
          position.chain,
          position.tokenAddress
        );

        if (tokenPerformance) {
          // Ensure all required fields are present
          tokens.push({
            chain: position.chain,
            address: position.tokenAddress,
            ...tokenPerformance,
          });
        }

        tokenSet.add(`${position.chain}:${position.tokenAddress}`);
      }

      // Map transactions to the expected type
      const mappedTransactions = transactions.map((tx) => {
        const position = filteredPositions.find((p) => p.tokenAddress === tx.tokenAddress);
        return {
          id: uuidv4() as UUID,
          positionId: (position?.id as UUID) || (uuidv4() as UUID),
          chain: position?.chain || '',
          type: tx.type.toUpperCase() as 'BUY' | 'SELL' | 'transfer_in' | 'transfer_out',
          tokenAddress: tx.tokenAddress,
          transactionHash: tx.transactionHash,
          amount: BigInt(tx.amount),
          price: tx.price?.toString(),
          isSimulation: tx.isSimulation,
          timestamp: new Date(tx.timestamp),
        } as unknown as Transaction;
      });

      const {
        positionReports,
        tokenReports,
        totalCurrentValue,
        totalPnL,
        totalRealizedPnL,
        totalUnrealizedPnL,
        positionsWithBalance,
      } = formatFullReport(tokens, filteredPositions, mappedTransactions);

      if (callback) {
        const formattedPositions = positionsWithBalance
          .map(({ position, token, transactions }) => {
            const _latestTx = transactions[transactions.length - 1];
            const currentValue = token.price
              ? (Number(position.balance) * token.price).toString()
              : '0';

            const pnlPercent =
              token.price && position.initialPrice
                ? (
                    ((Number(token.price) - Number(position.initialPrice)) /
                      Number(position.initialPrice)) *
                    100
                  ).toFixed(2)
                : '0';

            return (
              `**${token.symbol} (${token.name})**\n` +
              `Address: ${token.address}\n` +
              `Price: $${token.price}\n` +
              `Value: $${currentValue}\n` +
              `P&L: ${pnlPercent}%\n`
            );
          })
          .join('\n\n');

        const summary = `💰 **Your Portfolio Summary**\nTotal Value: ${totalCurrentValue}\nTotal P&L: ${totalPnL}\nRealized: ${totalRealizedPnL}\nUnrealized: ${totalUnrealizedPnL}`;

        const responseMemory: Memory = {
          content: {
            text:
              positionsWithBalance.length > 0
                ? `${summary}\n\n${formattedPositions}`
                : 'No open positions found.',
            inReplyTo: message.id ? message.id : undefined,
            actions: ['GET_POSITIONS'],
          },
          entityId: message.entityId,
          metadata: message.metadata,
          agentId: message.agentId,
          roomId: message.roomId,
          createdAt: Date.now() * 1000,
        };
        await callback(responseMemory);
      }
    } catch (error) {
      console.error('Error in getPositions:', error);
      throw error;
    }
  },

  async validate(_runtime: IAgentRuntime, message: Memory) {
    if (message.agentId === message.entityId) return false;
    return true;
  },
};
