import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  composePromptFromState,
  ModelType,
  type TemplateType,
  parseJSONObjectFromText,
} from '@elizaos/core';
import snapshot from '@snapshot-labs/snapshot.js';
import { Wallet, JsonRpcProvider } from 'ethers';
import { participateInVoteTemplate } from '../templates';
import { GOVERNANCE_ERROR_MESSAGES, GENERIC_GOVERNANCE_ERROR_MESSAGE } from '../constants';

// Interface for the parameters accepted by the action
interface ParticipateInVoteParams {
  space: string;
  proposalId: string;
  choice: number | string;
}

export const participateInVoteAction: Action = {
  name: 'ALETHEA_PARTICIPATE_IN_VOTE',
  similes: ['VOTE', 'CAST_VOTE', 'PARTICIPATE_IN_GOVERNANCE'].map((s) => `ALETHEA_${s}`),
  description: 'Participate in AI Protocol governance votes (via Snapshot).',

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    logger.info(`[participateInVoteAction] Validate called.`);

    const privateKey = runtime.getSetting('PRIVATE_KEY');
    if (!privateKey) {
      logger.error(
        '[participateInVoteAction] PRIVATE_KEY is required for voting. Please set it in agent settings.'
      );
      return false;
    }

    const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL');
    if (!rpcUrl) {
      logger.error(
        '[participateInVoteAction] ALETHEA_RPC_URL is required for voting. Please set it in agent settings.'
      );
      return false;
    }

    logger.info('[participateInVoteAction] Basic validation passed.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[participateInVoteAction] Handler called.');

    let voteParams: ParticipateInVoteParams | undefined;

    try {
      const prompt = composePromptFromState({
        state,
        template: participateInVoteTemplate as unknown as TemplateType,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      let paramsJson: ParticipateInVoteParams | { error: string };

      try {
        paramsJson = parseJSONObjectFromText(modelResponse) as
          | ParticipateInVoteParams
          | { error: string };
        logger.debug('Vote parameters extracted:', paramsJson);

        if ('error' in paramsJson) {
          logger.warn(`Vote action: Model responded with error: ${paramsJson.error}`);
          throw new Error(paramsJson.error);
        }
        voteParams = paramsJson;
      } catch (e) {
        logger.error('Failed to parse LLM response for vote params:', modelResponse, e);
        throw new Error('Could not understand vote parameters.');
      }

      const { space, proposalId, choice } = voteParams;
      const privateKey = runtime.getSetting('PRIVATE_KEY') as string;
      const rpcUrl = runtime.getSetting('ALETHEA_RPC_URL') as string;
      const snapshotApiUrl = runtime.getSetting('SNAPSHOT_API_URL') || 'https://hub.snapshot.org';

      if (!space || !proposalId || choice === undefined) {
        throw new Error('Space ID, Proposal ID, and Choice are required.');
      }

      const client = new snapshot.Client712(snapshotApiUrl);
      const provider = new JsonRpcProvider(rpcUrl);
      const wallet = new Wallet(privateKey, provider);
      const voterAddress = await wallet.getAddress();

      logger.info(
        `[participateInVoteAction] Casting vote for proposal ${proposalId} in space ${space}...`
      );

      const receipt = await client.vote(wallet as any, voterAddress, {
        space,
        proposal: proposalId,
        type: 'single-choice', // Assuming single-choice, might need to be dynamic
        choice: Number(choice),
        reason: 'Vote cast by ElizaOS Agent',
        app: 'elizaos-alethea-plugin',
      });

      logger.info(`[participateInVoteAction] Vote successfully cast.`, receipt);

      const receiptData = receipt as { id: string };

      const responseText =
        `✅ **Vote Cast Successfully**\n\n` +
        `**Space:** ${space}\n` +
        `**Proposal ID:** ${proposalId}\n` +
        `**Choice:** ${choice}\n` +
        `**Voter:** ${voterAddress}\n` +
        `**Signature:** ${receiptData.id}`;

      const responseContent: Content = {
        text: responseText,
        data: { ...receiptData, signature: receiptData.id, txHash: undefined },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[participateInVoteAction] Error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during voting.';
      const errorContent: Content = {
        text: `❌ **Error casting vote**: ${errorMessage}`,
        data: {
          error: errorMessage,
          ...voteParams,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Vote on proposal 0xabc...def in space alethea-ai.eth with choice 1 via Alethea.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Casting your vote via Alethea...',
          actions: ['ALETHEA_PARTICIPATE_IN_VOTE'],
        },
      },
    ],
  ],
};

// Interface for Governance Error
interface GovernanceError {
  code: number;
  message?: string;
  data?: any;
}

export const handleGovernanceErrorsAction: Action = {
  name: 'ALETHEA_HANDLE_GOVERNANCE_ERRORS',
  similes: [
    'PROCESS_ERROR',
    'HANDLE_ERROR',
    'MANAGE_GOVERNANCE_ERROR',
    'INTERPRET_GOVERNANCE_ERROR',
  ].map((s) => `ALETHEA_${s}`),
  description:
    'Handle and interpret AI Protocol governance errors (550–558) by providing a human-readable message.',

  validate: async (): Promise<boolean> => {
    logger.info(
      `[handleGovernanceErrorsAction] Validate called. This is a utility action, so it always passes validation.`
    );
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: any },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[handleGovernanceErrorsAction] Handler called.');

    const error = options?.error as GovernanceError;

    if (!error || typeof error.code === 'undefined') {
      const errMsg = 'No error object or error code provided to handle.';
      logger.error(`[handleGovernanceErrorsAction] ${errMsg}`);
      if (callback) await callback({ text: `❌ Error: ${errMsg}` });
      throw new Error(errMsg);
    }

    const errorCode = Number(error.code);
    const errorMessage = GOVERNANCE_ERROR_MESSAGES[errorCode] || GENERIC_GOVERNANCE_ERROR_MESSAGE;

    logger.info(`[handleGovernanceErrorsAction] Handling error code ${errorCode}: ${errorMessage}`);

    const responseText =
      `ℹ️ **Governance Error Details**\n\n` +
      `**Error Code:** ${errorCode}\n` +
      `**Message:** ${errorMessage}\n`;

    const responseContent: Content = {
      text: responseText,
      data: {
        code: errorCode,
        message: errorMessage,
        originalError: error,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return responseContent;
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I received a governance error with code 551 from Alethea. What does it mean?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me check the meaning of Alethea governance error 551 for you.',
          actions: ['ALETHEA_HANDLE_GOVERNANCE_ERRORS'],
        },
      },
    ],
  ],
};
