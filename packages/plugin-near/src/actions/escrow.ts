import {
  Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  elizaLogger,
} from '@elizaos/core';
import { EscrowService } from '../services/EscrowService';

// Helper to extract escrow parameters from text
function parseEscrowParams(text: string): {
  type: 'create' | 'join' | 'resolve' | 'cancel';
  parties?: Array<{ address: string; stake: string; prediction: any }>;
  condition?: string;
  contractId?: string;
  winnerId?: string;
} | null {
  const createMatch = text.match(
    /create\s+(?:an?\s+)?(?:escrow\s+)?bet\s+(?:between|with)\s+([\w.]+)\s+(?:and\s+)?([\w.]+)?\s+for\s+([\d.]+)\s+NEAR\s+(?:each\s+)?(?:on|about)\s+(.+)/i
  );
  if (createMatch) {
    const [, party1, party2, stake, condition] = createMatch;
    return {
      type: 'create',
      parties: [
        { address: party1, stake, prediction: 'yes' },
        { address: party2 || 'pending', stake, prediction: 'no' },
      ],
      condition,
    };
  }

  const joinMatch = text.match(/join\s+(?:the\s+)?escrow\s+(?:bet\s+)?(.+)/i);
  if (joinMatch) {
    return {
      type: 'join',
      contractId: joinMatch[1].trim(),
    };
  }

  const resolveMatch = text.match(
    /resolve\s+(?:the\s+)?escrow\s+(?:bet\s+)?(.+)\s+(?:winner|won by)\s+([\w.]+)/i
  );
  if (resolveMatch) {
    return {
      type: 'resolve',
      contractId: resolveMatch[1].trim(),
      winnerId: resolveMatch[2],
    };
  }

  const cancelMatch = text.match(/cancel\s+(?:the\s+)?escrow\s+(?:bet\s+)?(.+)/i);
  if (cancelMatch) {
    return {
      type: 'cancel',
      contractId: cancelMatch[1].trim(),
    };
  }

  return null;
}

export const escrowAction: Action = {
  name: 'ESCROW_BET',
  similes: ['CREATE_BET', 'MANAGE_ESCROW', 'RESOLVE_BET', 'ARBITER'],
  description: 'Manage escrow bets and conditional payments between parties',
  examples: [
    [
      {
        user: 'user',
        content: {
          text: 'Create an escrow bet between alice.near and bob.near for 1 NEAR each on whether BTC will reach $100k by end of year',
        },
      },
      {
        user: 'assistant',
        content: {
          text: 'I\'ll create an escrow bet between alice.near and bob.near for 1 NEAR each on "BTC reaching $100k by end of year".',
          actions: ['ESCROW_BET'],
        },
      },
    ],
    [
      {
        user: 'user',
        content: {
          text: 'Resolve the escrow bet escrow-1234 winner alice.near',
        },
      },
      {
        user: 'assistant',
        content: {
          text: "I'll resolve the escrow bet escrow-1234 with alice.near as the winner.",
          actions: ['ESCROW_BET'],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const escrowService = runtime.getService('near-escrow' as any) as EscrowService;
      if (!escrowService) {
        elizaLogger.warn('Escrow service not available');
        return false;
      }

      const params = parseEscrowParams(message.content.text);
      return params !== null;
    } catch (error) {
      elizaLogger.error('Escrow validation error:', error);
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<{ text: string; data?: any } | null | void | boolean> => {
    try {
      const escrowService = runtime.getService('near-escrow' as any) as EscrowService;
      if (!escrowService) {
        throw new Error('Escrow service not available');
      }

      const params = parseEscrowParams(message.content.text);
      if (!params) {
        throw new Error('Could not parse escrow parameters');
      }

      elizaLogger.info('Processing escrow action:', params);

      let result: string;
      let contractId: string | undefined;

      switch (params.type) {
        case 'create':
          if (!params.parties || !params.condition) {
            throw new Error('Missing parties or condition for bet creation');
          }

          contractId = await escrowService.createBetEscrow({
            type: 'escrow_bet',
            parties: params.parties,
            condition: params.condition,
            deadline: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
            arbiter: escrowService['walletService'].getAddress(),
          });

          result = `Created escrow bet ${contractId} between ${params.parties.map((p) => p.address).join(' and ')} for ${params.parties[0].stake} NEAR each on "${params.condition}"`;
          break;

        case 'join':
          if (!params.contractId) {
            throw new Error('Missing contract ID');
          }

          await escrowService.joinEscrow(params.contractId);
          result = `Joined escrow bet ${params.contractId}`;
          break;

        case 'resolve':
          if (!params.contractId || !params.winnerId) {
            throw new Error('Missing contract ID or winner ID');
          }

          await escrowService.resolveEscrow(params.contractId, params.winnerId);
          result = `Resolved escrow bet ${params.contractId} with winner ${params.winnerId}`;
          break;

        case 'cancel':
          if (!params.contractId) {
            throw new Error('Missing contract ID');
          }

          await escrowService.cancelEscrow(params.contractId);
          result = `Cancelled escrow bet ${params.contractId}`;
          break;

        default:
          throw new Error('Unknown escrow operation');
      }

      elizaLogger.success(result);

      if (callback) {
        await callback({
          text: result,
          actions: ['ESCROW_BET'],
          data: {
            contractId,
            escrowType: params.type,
            ...params,
          },
        });
      }

      return {
        text: result,
        data: {
          contractId,
          escrowType: params.type,
          ...params,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      elizaLogger.error('Escrow action failed:', error);

      const errorResponse = `Failed to process escrow: ${errorMessage}`;

      if (callback) {
        await callback({
          text: errorResponse,
          error: errorMessage,
        });
      }

      return {
        text: errorResponse,
        data: { error: errorMessage },
      };
    }
  },
};
