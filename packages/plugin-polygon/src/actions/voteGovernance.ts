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
  type ActionExample,
  parseJSONObjectFromText,
} from '@elizaos/core';
import { encodeFunctionData, type Address, type Chain, type Hex, type Log } from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { voteGovernanceActionTemplate } from '../templates'; // Import the new template

// Minimal ABI for OZ Governor castVote function
const governorVoteAbi = [
  {
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' }, // 0 = Against, 1 = For, 2 = Abstain
      // { name: 'reason', type: 'string' }, // For castVoteWithReason (optional)
    ],
    name: 'castVote', // or castVoteWithReason
    outputs: [], // Typically returns a boolean success or nothing, tx receipt is key
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ABI for castVoteWithReason (if you intend to support it)
const governorVoteWithReasonAbi = [
  {
    inputs: [
      { name: 'proposalId', type: 'uint256' },
      { name: 'support', type: 'uint8' },
      { name: 'reason', type: 'string' },
    ],
    name: 'castVoteWithReason',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

interface VoteGovernanceParams {
  chain: string;
  governorAddress: Address;
  proposalId: string; // string for LLM, convert to BigInt for tx
  support: number; // 0, 1, or 2
  reason?: string; // Optional
}

interface VoteTransaction {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  chainId: number;
  data?: Hex;
  logs?: Log[];
  proposalId: string; // Keep as string from params for consistency
  support: number;
  reason?: string;
}

// Helper function to extract params from text
function extractVoteGovernanceParamsFromText(text: string): Partial<VoteGovernanceParams> {
  const params: Partial<VoteGovernanceParams> = {};
  logger.debug(`Attempting to extract VoteGovernanceParams from text: "${text}"`);

  const chainMatch = text.match(/\b(?:on\s+|chain\s*[:\-]?\s*)(\w+)/i);
  if (chainMatch?.[1]) params.chain = chainMatch[1].toLowerCase();

  const governorMatch = text.match(/\b(?:governor\s*(?:address\s*)?[:\-]?\s*)(0x[a-fA-F0-9]{40})/i);
  if (governorMatch?.[1]) params.governorAddress = governorMatch[1] as Address;

  const proposalIdMatch = text.match(/\b(?:proposal\s*id|prop\s*id)\s*[:\-]?\s*([\w\d\-]+)/i); // Allow hex, numbers, or GUID-like
  if (proposalIdMatch?.[1]) params.proposalId = proposalIdMatch[1];

  // Support: 0 (Against), 1 (For), 2 (Abstain)
  // Look for keywords like "for", "yes", "against", "no", "abstain"
  // Or numbers 0, 1, 2
  const supportForMatch = text.match(/\b(?:vote|support|option)\s*[:\-]?\s*(for|yes|aye)\b/i);
  const supportAgainstMatch = text.match(
    /\b(?:vote|support|option)\s*[:\-]?\s*(against|no|nay)\b/i
  );
  const supportAbstainMatch = text.match(/\b(?:vote|support|option)\s*[:\-]?\s*(abstain)\b/i);
  const supportNumericMatch = text.match(/\b(?:vote|support|option)\s*[:\-]?\s*([012])\b/i);

  if (supportForMatch) params.support = 1;
  else if (supportAgainstMatch) params.support = 0;
  else if (supportAbstainMatch) params.support = 2;
  else if (supportNumericMatch?.[1]) params.support = Number.parseInt(supportNumericMatch[1], 10);

  const reasonMatch = text.match(
    /\b(?:reason|rationale)\s*[:\-]?\s*(?:['"“](.+?)['"”]|(.+?)(?:\s*\b(?:chain|governor|proposalId|support)\b|$))/i
  );
  if (reasonMatch) {
    params.reason = (reasonMatch[1] || reasonMatch[2])?.trim();
  }

  logger.debug('Manually extracted VoteGovernanceParams:', params);
  return params;
}

class PolygonVoteGovernanceActionRunner {
  constructor(private walletProvider: WalletProvider) {}

  async vote(params: VoteGovernanceParams): Promise<VoteTransaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);
    const chainConfig = this.walletProvider.getChainConfigs(params.chain);

    if (!walletClient.account) {
      throw new Error('Wallet client account is not available.');
    }
    const senderAddress = walletClient.account.address;

    const proposalIdBigInt = BigInt(params.proposalId); // Convert proposalId to BigInt

    let txData: Hex;
    if (params.reason && params.reason.trim() !== '') {
      txData = encodeFunctionData({
        abi: governorVoteWithReasonAbi,
        functionName: 'castVoteWithReason',
        args: [proposalIdBigInt, params.support, params.reason],
      });
    } else {
      txData = encodeFunctionData({
        abi: governorVoteAbi,
        functionName: 'castVote',
        args: [proposalIdBigInt, params.support],
      });
    }

    try {
      logger.debug(
        `Voting on chain ${params.chain}, governor ${params.governorAddress}, proposal ${params.proposalId}, support ${params.support}, reason: "${params.reason || ''}"`
      );
      const kzg = {
        blobToKzgCommitment: (_blob: unknown) => {
          throw new Error('KZG not impl.');
        },
        computeBlobKzgProof: (_blob: unknown, _commit: unknown) => {
          throw new Error('KZG not impl.');
        },
      };
      const hash = await walletClient.sendTransaction({
        account: senderAddress,
        to: params.governorAddress,
        value: BigInt(0),
        data: txData,
        chain: chainConfig as Chain,
        kzg,
      });

      logger.info(`Vote transaction sent. Hash: ${hash}. Waiting for receipt...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      logger.debug('Transaction receipt:', receipt);

      return {
        hash,
        from: senderAddress,
        to: params.governorAddress,
        value: BigInt(0),
        data: txData,
        chainId: chainConfig.id,
        logs: receipt.logs as Log[],
        proposalId: params.proposalId,
        support: params.support,
        reason: params.reason,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Governance vote failed: ${errMsg}`, error);
      throw new Error(`Governance vote failed: ${errMsg}`);
    }
  }
}

export const voteGovernanceAction: Action = {
  name: 'POLYGON_VOTE_GOVERNANCE_PROPOSAL',
  similes: ['CAST_VOTE', 'SUPPORT_PROPOSAL', 'VOTE_ON_PROPOSAL'].map((s) => `POLYGON_${s}`),
  description: 'Votes on a governance proposal on Polygon.',
  parameters: {
    type: 'object',
  },

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    logger.debug('Validating POLYGON_VOTE_GOVERNANCE action...');
    if (
      !runtime.getSetting('WALLET_PRIVATE_KEY') ||
      !runtime.getSetting('POLYGON_PLUGINS_ENABLED')
    ) {
      logger.error(
        'Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) are not configured.'
      );
      return false;
    }
    try {
      await initWalletProvider(runtime);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.error(`WalletProvider initialization failed during validation: ${errMsg}`);
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback: HandlerCallback | undefined,
    _responses: Memory[] | undefined
  ) => {
    logger.info('Handling POLYGON_VOTE_GOVERNANCE for message:', message.id);
    const rawMessageText = message.content.text || '';
    let extractedParams: (Partial<VoteGovernanceParams> & { error?: string }) | null = null;

    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonVoteGovernanceActionRunner(walletProvider);

      const prompt = composePromptFromState({
        state,
        template: voteGovernanceActionTemplate, // Use the new string template
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      try {
        const parsed = parseJSONObjectFromText(modelResponse);
        if (parsed) {
          extractedParams = parsed as Partial<VoteGovernanceParams> & {
            error?: string;
          };
        }
        logger.debug('POLYGON_VOTE_GOVERNANCE: Extracted params via TEXT_SMALL:', extractedParams);

        if (extractedParams?.error) {
          logger.warn(
            `POLYGON_VOTE_GOVERNANCE: Model responded with error: ${extractedParams.error}`
          );
          throw new Error(extractedParams.error);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(
          `POLYGON_VOTE_GOVERNANCE: Failed to parse JSON from model response or model returned error (Proceeding to manual extraction): ${errorMsg}`
        );
      }

      if (
        !extractedParams ||
        extractedParams.error ||
        !extractedParams.chain ||
        !extractedParams.governorAddress ||
        extractedParams.proposalId === undefined ||
        extractedParams.support === undefined // Support can be 0
      ) {
        logger.info(
          'POLYGON_VOTE_GOVERNANCE: Model extraction insufficient or failed, attempting manual parameter extraction.'
        );
        const manualParams = extractVoteGovernanceParamsFromText(rawMessageText);

        if (extractedParams && !extractedParams.error) {
          extractedParams = {
            chain: extractedParams.chain || manualParams.chain,
            governorAddress: extractedParams.governorAddress || manualParams.governorAddress,
            proposalId: extractedParams.proposalId || manualParams.proposalId,
            support:
              extractedParams.support !== undefined
                ? extractedParams.support
                : manualParams.support, // Check for undefined explicitly for support
            reason: extractedParams.reason || manualParams.reason,
          };
        } else {
          extractedParams = manualParams;
        }
        logger.debug(
          'POLYGON_VOTE_GOVERNANCE: Params after manual extraction attempt:',
          extractedParams
        );
      }

      if (
        !extractedParams?.chain ||
        !extractedParams.governorAddress ||
        extractedParams.proposalId === undefined || // Check for undefined
        typeof extractedParams.support !== 'number' || // Check for number type and range
        ![0, 1, 2].includes(extractedParams.support)
      ) {
        logger.error(
          'POLYGON_VOTE_GOVERNANCE: Incomplete or invalid parameters after all extraction attempts.',
          extractedParams
        );
        throw new Error(
          'Incomplete or invalid vote parameters: chain, governorAddress, proposalId, and support (0, 1, or 2) are required.'
        );
      }

      const voteParams = extractedParams as VoteGovernanceParams;

      logger.debug('Vote governance parameters for runner:', voteParams);
      const txResult = await actionRunner.vote(voteParams);

      const successMsg = `Successfully voted on proposal ${voteParams.proposalId} on chain ${voteParams.chain} for governor ${voteParams.governorAddress}. Support: ${voteParams.support}. TxHash: ${txResult.hash}.`;
      logger.info(successMsg);

      if (callback) {
        await callback({
          text: `Successfully cast vote for proposal ${voteParams.proposalId}. Tx hash: ${txResult.hash}`,
          content: { success: true, ...txResult },
          actions: ['POLYGON_VOTE_GOVERNANCE'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error in VOTE_GOVERNANCE_POLYGON handler: ${errMsg}`, error);
      if (callback) {
        await callback({
          text: `Error voting on proposal: ${errMsg}`,
          actions: ['POLYGON_VOTE_GOVERNANCE'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Vote for proposal 123 on the Polygon mainnet governor 0xabc123.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I have cast a "for" vote on proposal 123 on the Polygon mainnet governor at 0xabc123.',
          actions: ['POLYGON_VOTE_GOVERNANCE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Vote against proposal 456 on the Polygon mumbai governor 0xdef456. My reason is "This is not a good idea."',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I have cast an "against" vote on proposal 456 on the Polygon mumbai governor at 0xdef456 with the reason "This is not a good idea."',
          actions: ['POLYGON_VOTE_GOVERNANCE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Abstain from voting on proposal 789 on the Polygon mainnet governor 0xghi789.',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I have cast an "abstain" vote on proposal 789 on the Polygon mainnet governor at 0xghi789.',
          actions: ['POLYGON_VOTE_GOVERNANCE'],
        },
      },
    ],
  ],
};
