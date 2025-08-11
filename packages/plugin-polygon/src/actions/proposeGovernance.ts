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
// import { type Chain, polygon as polygonChain, mainnet as ethereumChain } from 'viem/chains'; // Chains managed by Provider
import {
  // createWalletClient, http, type WalletClient, // Provided by WalletProvider instance
  encodeFunctionData,
  type Address,
  type Hex,
  // PublicClient, createPublicClient, fallback, // Provided by WalletProvider instance
  type Transport, // Not directly used, but WalletProvider uses it
  type Account, // Not directly used, but WalletProvider uses it
  type Chain, // For type annotation
  type Log,
  parseUnits, // Added for currency parsing
} from 'viem';
// import { privateKeyToAccount } from 'viem/accounts'; // Handled by Provider

import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { proposeGovernanceActionTemplate } from '../templates';

// Minimal ABI for OZ Governor propose function
const governorProposeAbi = [
  {
    inputs: [
      { name: 'targets', type: 'address[]' },
      { name: 'values', type: 'uint256[]' },
      { name: 'calldatas', type: 'bytes[]' },
      { name: 'description', type: 'string' },
    ],
    name: 'propose',
    outputs: [{ name: 'proposalId', type: 'uint256' }],
    stateMutability: 'nonpayable', // or 'payable' if it can receive value
    type: 'function',
  },
] as const; // Use 'as const' for better type inference with viem

// REMOVE INLINE WalletProvider, ChainConfig, and initWalletProvider

interface ProposeGovernanceParams {
  chain: string; // e.g., "polygon", "ethereum"
  governorAddress: Address;
  targets: Address[];
  values: string[]; // Array of ETH values as strings (e.g., "0", "0.1") to be converted to BigInt
  calldatas: Hex[];
  description: string;
}

interface GovernanceTransaction extends Transaction {
  // Assuming Transaction type from bridgeDeposit
  logs?: Log[]; // viem Log[]
  proposalId?: bigint; // Extracted from logs if possible
}
interface Transaction {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  chainId: number;
  data?: Hex;
}

// Helper function to extract params from text if LLM fails
function extractProposeGovernanceParamsFromText(text: string): Partial<ProposeGovernanceParams> {
  const params: Partial<ProposeGovernanceParams> = {};
  logger.debug(`Attempting to extract ProposeGovernanceParams from text: "${text}"`);

  const chainMatch = text.match(/\b(?:on\s+|chain\s*[:\-]?\s*)(\w+)/i);
  if (chainMatch?.[1]) params.chain = chainMatch[1].toLowerCase();

  const governorMatch = text.match(/\b(?:governor\s*(?:address\s*)?[:\-]?\s*)(0x[a-fA-F0-9]{40})/i);
  if (governorMatch?.[1]) params.governorAddress = governorMatch[1] as Address;

  // Targets: "targets: [0x123, 0xabc]" or "target: 0x123" or "targets 0x123, 0x456"
  const targetsRgx = /\btargets?\s*[:\-]?\s*\[?((?:0x[a-fA-F0-9]{40}(?:\s*,\s*|\s+)?)+)\]?/i;
  const targetsMatch = text.match(targetsRgx);
  if (targetsMatch?.[1]) {
    params.targets = targetsMatch[1]
      .split(/[\s,]+/)
      .filter((t) => /^0x[a-fA-F0-9]{40}$/.test(t)) as Address[];
  }

  // Values: "values: [0, 100]" or "value: 0" or "values 0, 100"
  const valuesRgx = /\bvalues?\s*[:\-]?\s*\[?((?:\d+(?:\.\d+)?(?:\s*,\s*|\s+)?)+)\]?/i;
  const valuesMatch = text.match(valuesRgx);
  if (valuesMatch?.[1]) {
    params.values = valuesMatch[1].split(/[\s,]+/).filter((v) => /^\d+(?:\.\d+)?$/.test(v));
  }

  // Calldatas: "calldatas: [0xabc, 0xdef]" or "calldata: 0xabc" or "calldatas 0xabc, 0xdef"
  const calldatasRgx = /\bcalldatas?\s*[:\-]?\s*\[?((?:0x[a-fA-F0-9]+(?:\s*,\s*|\s+)?)+)\]?/i;
  const calldatasMatch = text.match(calldatasRgx);
  if (calldatasMatch?.[1]) {
    params.calldatas = calldatasMatch[1]
      .split(/[\s,]+/)
      .filter((c) => /^0x[a-fA-F0-9]+$/.test(c)) as Hex[];
  }

  // Description: "desc: "My Proposal"" or "description is 'Another one'"
  // This regex tries to capture quoted strings or up to the end of the line/next parameter.
  const descriptionMatch = text.match(
    /\b(?:desc(?:ription)?\s*[:\-]?\s*)(?:(?:['"""](.+?)['"'"])|(.*?)(?:\s*\b(?:chain|governor|targets|values|calldatas)\b|$))/i
  );
  if (descriptionMatch) {
    params.description = (descriptionMatch[1] || descriptionMatch[2])?.trim();
  }

  logger.debug('Manually extracted ProposeGovernanceParams:', params);
  return params;
}

class PolygonProposeGovernanceActionRunner {
  constructor(private walletProvider: WalletProvider) {} // Use imported WalletProvider

  async propose(params: ProposeGovernanceParams): Promise<GovernanceTransaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);
    const chainConfig = this.walletProvider.getChainConfigs(params.chain); // viem.Chain from provider

    if (!walletClient.account) {
      throw new Error('Wallet client account is not available.');
    }
    const senderAddress = walletClient.account.address;

    // Convert currency strings (e.g., "0.5 ETH") to wei strings
    const processedValues = params.values.map((valueStr) => {
      const lowerValueStr = valueStr.toLowerCase();
      const decimals = 18; // Default to 18 for ETH/MATIC

      if (lowerValueStr.includes('eth') || lowerValueStr.includes('matic')) {
        // Extract numeric part, removing the unit. Regex backslash is escaped for code_edit.
        const numericPart = valueStr.replace(/\\s*(eth|matic)/i, '').trim();
        try {
          // parseUnits expects a string for the amount
          return parseUnits(numericPart, decimals).toString();
        } catch (e) {
          logger.warn(
            `Could not parse value "${valueStr}" with parseUnits. Attempting direct BigInt conversion of numeric part "${numericPart}".`
          );
          // If parseUnits fails, return the extracted numericPart for BigInt to try.
          return numericPart;
        }
      }
      // If no unit, assume it's already in wei or a plain number string
      return valueStr;
    });

    const numericValues = processedValues.map((v) => {
      try {
        return BigInt(v);
      } catch (e) {
        logger.error(
          `Failed to convert processed value "${v}" to BigInt. Original param values: ${JSON.stringify(params.values)}`
        );
        throw new Error(
          `Invalid numeric value for transaction: "${v}". Expected a number string convertible to BigInt (wei).`
        );
      }
    });

    const txData = encodeFunctionData({
      abi: governorProposeAbi,
      functionName: 'propose',
      args: [params.targets, numericValues, params.calldatas, params.description],
    });

    try {
      logger.debug(
        `Proposing on ${params.chain} to ${params.governorAddress} with description "${params.description}"`
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

      logger.info(`Proposal transaction sent. Hash: ${hash}. Waiting for receipt...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      logger.debug('Transaction receipt:', receipt);

      let proposalId: bigint | undefined;
      // Attempt to find ProposalCreated event (OpenZeppelin Governor standard)
      // Example: { eventName: 'ProposalCreated', args: { proposalId: ... } }
      const proposalCreatedEventAbi = governorProposeAbi.find((item) => item.name === 'propose');
      // This is not an event, ABI is for the function. Parsing logs for proposalId is complex and ABI-dependent.
      // For now, we'll leave proposalId undefined unless a clearer generic method is found.
      // Often, the proposalId is returned by the function call in some Governor versions, or emitted in a specific event.
      // If `outputs: [{ name: 'proposalId', type: 'uint256' }]` is standard, viem might return it or parse from logs.
      // However, direct return value from sendTransaction is just the hash.
      // Parsing from `receipt.logs` requires knowing the exact event signature and topics.

      return {
        hash,
        from: senderAddress,
        to: params.governorAddress,
        value: BigInt(0),
        data: txData,
        chainId: chainConfig.id,
        logs: receipt.logs as Log[],
        proposalId,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Governance proposal failed: ${errMsg}`, error);
      throw new Error(`Governance proposal failed: ${errMsg}`);
    }
  }
}

export const proposeGovernanceAction: Action = {
  name: 'POLYGON_PROPOSE_GOVERNANCE',
  similes: ['CREATE_PROPOSAL', 'SUBMIT_GOVERNANCE_ACTION'].map((s) => `POLYGON_${s}`),
  description: 'Creates a new governance proposal on Polygon.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined
  ): Promise<boolean> => {
    logger.debug('Validating PROPOSE_GOVERNANCE action...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((check) => !check)) {
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
    logger.info(`Handling PROPOSE_GOVERNANCE for message: ${message.id}`);
    const rawMessageText = message.content.text || '';
    let extractedParams: (Partial<ProposeGovernanceParams> & { error?: string }) | null = null;

    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonProposeGovernanceActionRunner(walletProvider);

      const prompt = composePromptFromState({
        state,
        template: proposeGovernanceActionTemplate,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      try {
        const parsed = parseJSONObjectFromText(modelResponse);
        if (parsed) {
          extractedParams = parsed as Partial<ProposeGovernanceParams> & {
            error?: string;
          };
        }
        logger.debug('PROPOSE_GOVERNANCE: Extracted params via TEXT_SMALL:', extractedParams);

        if (extractedParams?.error) {
          logger.warn(`PROPOSE_GOVERNANCE: Model responded with error: ${extractedParams.error}`);
          throw new Error(extractedParams.error);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(
          `PROPOSE_GOVERNANCE: Failed to parse JSON from model (Proceeding to manual): ${errorMsg}`
        );
      }

      // If model failed, or returned an error (which would make extractedParams null or have an error), or is incomplete:
      if (
        !extractedParams ||
        extractedParams.error ||
        !extractedParams.chain ||
        !extractedParams.governorAddress ||
        !extractedParams.targets ||
        !extractedParams.values ||
        !extractedParams.calldatas ||
        !extractedParams.description
      ) {
        logger.info(
          'PROPOSE_GOVERNANCE: Model extraction insufficient, attempting manual extraction.'
        );
        const manualParams = extractProposeGovernanceParamsFromText(rawMessageText);

        // If model gave partial valid params, merge with manual. Otherwise, use manual.
        // Prioritize manually extracted fields if model fields are missing.
        if (extractedParams && !extractedParams.error) {
          extractedParams = {
            chain: extractedParams.chain || manualParams.chain,
            governorAddress: extractedParams.governorAddress || manualParams.governorAddress,
            targets:
              extractedParams.targets && extractedParams.targets.length > 0
                ? extractedParams.targets
                : manualParams.targets,
            values:
              extractedParams.values && extractedParams.values.length > 0
                ? extractedParams.values
                : manualParams.values,
            calldatas:
              extractedParams.calldatas && extractedParams.calldatas.length > 0
                ? extractedParams.calldatas
                : manualParams.calldatas,
            description: extractedParams.description || manualParams.description,
          };
        } else {
          extractedParams = manualParams;
        }
        logger.debug(
          'PROPOSE_GOVERNANCE: Params after manual extraction attempt:',
          extractedParams
        );
      }

      // Final validation of parameters
      if (
        !extractedParams?.chain ||
        !extractedParams.governorAddress ||
        !extractedParams.targets ||
        !(extractedParams.targets.length > 0) || // Ensure targets is not empty
        !extractedParams.values ||
        !(extractedParams.values.length > 0) || // Ensure values is not empty
        !extractedParams.calldatas ||
        !(extractedParams.calldatas.length > 0) || // Ensure calldatas is not empty
        !extractedParams.description
      ) {
        logger.error(
          'PROPOSE_GOVERNANCE: Incomplete parameters after all extraction attempts.',
          extractedParams
        );
        throw new Error(
          'Incomplete or invalid proposal parameters extracted after all attempts. Required: chain, governorAddress, targets, values, calldatas, description.'
        );
      }

      // Type assertion because we've validated all fields
      const proposeParams = extractedParams as ProposeGovernanceParams;

      logger.debug('Propose governance parameters for runner:', proposeParams);
      const txResult = await actionRunner.propose(proposeParams);

      let successMsg = `Proposed governance action on ${proposeParams.chain} to ${proposeParams.governorAddress}. Desc: "${proposeParams.description}". TxHash: ${txResult.hash}.`;
      if (txResult.proposalId) {
        successMsg += ` Proposal ID: ${txResult.proposalId}`;
      }
      logger.info(successMsg);

      if (callback) {
        await callback({
          text: `Successfully created proposal. Tx hash: ${txResult.hash}. Proposal ID may be available in the transaction logs.`,
          content: { success: true, ...txResult },
          actions: ['PROPOSE_GOVERNANCE'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error in PROPOSE_GOVERNANCE handler: ${errMsg}`, error);
      if (callback) {
        await callback({
          text: `Error submitting governance proposal: ${errMsg}`,
          actions: ['PROPOSE_GOVERNANCE'],
          source: message.content.source,
        });
      }
      return { success: false, error: errMsg };
    }
  },

  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Propose on polygon to governor 0x123 targets [0x456] values [0] calldatas [0x789] with description "Test proposal"',
        },
      },
      {
        name: 'user',
        content: {
          text: "Create a new proposal. Chain: polygon. Governor: 0xabc. Targets: [0xdef]. Values: ['0']. Calldatas: ['0xghi']. Description: Hello world.",
        },
      },
    ],
  ],
};
