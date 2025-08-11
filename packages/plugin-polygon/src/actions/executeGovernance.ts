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
import {
  createWalletClient,
  http,
  type WalletClient,
  encodeFunctionData,
  type Address,
  type Hex,
  PublicClient,
  createPublicClient,
  fallback,
  keccak256,
  stringToHex,
  type Transport,
  type Account,
  type Chain,
  type Log,
} from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { executeGovernanceActionTemplate } from '../templates';

// Minimal ABI for OZ Governor execute function
const governorExecuteAbi = [
  {
    inputs: [
      { name: 'targets', type: 'address[]' },
      { name: 'values', type: 'uint256[]' },
      { name: 'calldatas', type: 'bytes[]' },
      { name: 'descriptionHash', type: 'bytes32' },
    ],
    name: 'execute',
    outputs: [], // Or proposalId depending on version
    stateMutability: 'payable', // Execute can be payable
    type: 'function',
  },
] as const;

interface ExecuteGovernanceParams {
  chain: string;
  governorAddress: Address;
  targets: Address[];
  values: string[]; // ETH values as strings
  calldatas: Hex[];
  description: string; // Full description, hash calculated by runner
}

interface ExecuteTransaction {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint; // This is the total value sent with the execute call, could be > 0
  chainId: number;
  data?: Hex;
  logs?: Log[];
  descriptionHash: Hex;
}

// Helper function to extract params from text
function extractExecuteGovernanceParamsFromText(text: string): Partial<ExecuteGovernanceParams> {
  const params: Partial<ExecuteGovernanceParams> = {};
  logger.debug(`Attempting to extract ExecuteGovernanceParams from text: "${text}"`);

  // Reuse extraction logic similar to propose/queue
  const chainMatch = text.match(/\b(?:on\s+|chain\s*[:\-]?\s*)(\w+)/i);
  if (chainMatch?.[1]) params.chain = chainMatch[1].toLowerCase();

  const governorMatch = text.match(/\b(?:governor\s*(?:address\s*)?[:\-]?\s*)(0x[a-fA-F0-9]{40})/i);
  if (governorMatch?.[1]) params.governorAddress = governorMatch[1] as Address;

  const targetsRgx = /\btargets?\s*[:\-]?\s*\[?((?:0x[a-fA-F0-9]{40}(?:\s*,\s*|\s+)?)+)\]?/i;
  const targetsMatch = text.match(targetsRgx);
  if (targetsMatch?.[1]) {
    params.targets = targetsMatch[1]
      .split(/[\s,]+/)
      .filter((t) => /^0x[a-fA-F0-9]{40}$/.test(t)) as Address[];
  }

  const valuesRgx = /\bvalues?\s*[:\-]?\s*\[?((?:\d+(?:\.\d+)?(?:\s*,\s*|\s+)?)+)\]?/i;
  const valuesMatch = text.match(valuesRgx);
  if (valuesMatch?.[1]) {
    params.values = valuesMatch[1].split(/[\s,]+/).filter((v) => /^\d+(?:\.\d+)?$/.test(v));
  }

  const calldatasRgx = /\bcalldatas?\s*[:\-]?\s*\[?((?:0x[a-fA-F0-9]+(?:\s*,\s*|\s+)?)+)\]?/i;
  const calldatasMatch = text.match(calldatasRgx);
  if (calldatasMatch?.[1]) {
    params.calldatas = calldatasMatch[1]
      .split(/[\s,]+/)
      .filter((c) => /^0x[a-fA-F0-9]+$/.test(c)) as Hex[];
  }

  const descriptionMatch = text.match(
    /\b(?:desc(?:ription)?\s*[:\-]?\s*)(?:(?:['"“](.+?)['"”])|(.*?)(?:\s*\b(?:chain|governor|targets|values|calldatas)\b|$))/i
  );
  if (descriptionMatch) {
    params.description = (descriptionMatch[1] || descriptionMatch[2])?.trim();
  }

  logger.debug('Manually extracted ExecuteGovernanceParams:', params);
  return params;
}

class PolygonExecuteGovernanceActionRunner {
  constructor(private walletProvider: WalletProvider) {}

  async execute(params: ExecuteGovernanceParams): Promise<ExecuteTransaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);
    const chainConfig = this.walletProvider.getChainConfigs(params.chain);

    if (!walletClient.account) {
      throw new Error('Wallet client account is not available.');
    }
    const senderAddress = walletClient.account.address;

    // Sum of values in the proposal actions, as execute itself can be payable.
    const executeCallValue =
      params.values.length > 0
        ? params.values.map((v) => BigInt(v)).reduce((a, b) => a + b, BigInt(0))
        : BigInt(0);
    const descriptionHash = keccak256(stringToHex(params.description));

    const txData = encodeFunctionData({
      abi: governorExecuteAbi,
      functionName: 'execute',
      args: [
        params.targets,
        params.values.map((v) => BigInt(v)), // Individual values for each target action
        params.calldatas,
        descriptionHash,
      ],
    });
    logger.debug(
      `Executing proposal on ${params.chain} at governor ${params.governorAddress} with descHash: ${descriptionHash}`
    );

    try {
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
        value: executeCallValue, // Total value for the transaction, if Governor's execute is payable
        data: txData,
        chain: chainConfig as Chain, // Ensure correct type for viem
        kzg,
      });
      logger.info(`Execute transaction sent. Hash: ${hash}. Waiting for receipt...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return {
        hash,
        from: senderAddress,
        to: params.governorAddress,
        value: executeCallValue,
        data: txData,
        chainId: chainConfig.id,
        logs: receipt.logs as Log[],
        descriptionHash,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Governance execute failed: ${errMsg}`, error);
      throw new Error(`Governance execute failed: ${errMsg}`);
    }
  }
}

export const executeGovernanceAction: Action = {
  name: 'POLYGON_EXECUTE_GOVERNANCE_PROPOSAL',
  similes: ['GOV_EXECUTE', 'RUN_POLYGON_PROPOSAL'].map((s) => `POLYGON_${s}`),
  description: 'Executes a queued governance proposal on Polygon.',
  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating EXECUTE_GOVERNANCE_POLYGON action...');
    const checks = [
      runtime.getSetting('WALLET_PRIVATE_KEY'),
      runtime.getSetting('POLYGON_PLUGINS_ENABLED'),
    ];
    if (checks.some((c) => !c)) {
      logger.error(
        'Required settings (WALLET_PRIVATE_KEY, POLYGON_PLUGINS_ENABLED) not configured.'
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
    logger.info('Handling EXECUTE_GOVERNANCE_POLYGON for message:', message.id);
    const rawMessageText = message.content.text || '';
    let extractedParams: (Partial<ExecuteGovernanceParams> & { error?: string }) | null = null;

    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonExecuteGovernanceActionRunner(walletProvider);

      const prompt = composePromptFromState({
        state,
        template: executeGovernanceActionTemplate,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      try {
        const parsed = parseJSONObjectFromText(modelResponse);
        if (parsed) {
          extractedParams = parsed as Partial<ExecuteGovernanceParams> & {
            error?: string;
          };
        }
        logger.debug(
          'EXECUTE_GOVERNANCE_POLYGON: Extracted params via TEXT_SMALL:',
          extractedParams
        );

        if (extractedParams?.error) {
          logger.warn(
            `EXECUTE_GOVERNANCE_POLYGON: Model responded with error: ${extractedParams.error}`
          );
          throw new Error(extractedParams.error);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(
          `EXECUTE_GOVERNANCE_POLYGON: Failed to parse JSON from model response or model returned error (Proceeding to manual extraction): ${errorMsg}`
        );
      }

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
          'EXECUTE_GOVERNANCE_POLYGON: Model extraction insufficient or failed, attempting manual parameter extraction.'
        );
        const manualParams = extractExecuteGovernanceParamsFromText(rawMessageText);

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
          'EXECUTE_GOVERNANCE_POLYGON: Params after manual extraction attempt:',
          extractedParams
        );
      }

      if (
        !extractedParams?.chain ||
        !extractedParams.governorAddress ||
        !extractedParams.targets ||
        !(extractedParams.targets.length > 0) ||
        !extractedParams.values ||
        !(extractedParams.values.length > 0) || // Values can be empty if executeCallValue is 0
        !extractedParams.calldatas ||
        !(extractedParams.calldatas.length > 0) ||
        !extractedParams.description
      ) {
        logger.error(
          'EXECUTE_GOVERNANCE_POLYGON: Incomplete parameters after all extraction attempts.',
          extractedParams
        );
        throw new Error(
          'Incomplete or invalid execute parameters extracted. Required: chain, governorAddress, targets, values, calldatas, description.'
        );
      }

      const executeParams = extractedParams as ExecuteGovernanceParams;

      logger.debug('Execute governance parameters for runner:', executeParams);
      const txResult = await actionRunner.execute(executeParams);
      const successMsg = `Successfully executed proposal on ${executeParams.chain} for governor ${executeParams.governorAddress} (Desc: "${executeParams.description}", DescHash: ${txResult.descriptionHash}). TxHash: ${txResult.hash}`;
      logger.info(successMsg);
      if (callback) {
        await callback({
          text: successMsg,
          content: { success: true, ...txResult },
          actions: ['EXECUTE_GOVERNANCE_POLYGON'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('Error in EXECUTE_GOVERNANCE_POLYGON handler:', errMsg, error);
      if (callback) {
        await callback({
          text: `Error executing proposal: ${errMsg}`,
          actions: ['EXECUTE_GOVERNANCE_POLYGON'],
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
          text: "Execute the queued proposal 'Test Prop E1' on Polygon governor 0xGov. Chain: polygon. Targets:[0xT1], Values:[0], Calldatas:[0xCD1]. Description: Test Description for E1.",
        },
      },
    ],
  ],
};
