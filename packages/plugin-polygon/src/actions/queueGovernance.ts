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
  encodeFunctionData,
  type Address,
  type Hex,
  keccak256,
  stringToHex,
  type Chain,
  type Log,
} from 'viem';
import { type WalletProvider, initWalletProvider } from '../providers/PolygonWalletProvider';
import { queueGovernanceActionTemplate } from '../templates';

// Minimal ABI for OZ Governor queue function
const governorQueueAbi = [
  {
    inputs: [
      { name: 'targets', type: 'address[]' },
      { name: 'values', type: 'uint256[]' },
      { name: 'calldatas', type: 'bytes[]' },
      { name: 'descriptionHash', type: 'bytes32' },
    ],
    name: 'queue',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

interface QueueGovernanceParams {
  chain: string;
  governorAddress: Address;
  targets: Address[];
  values: string[];
  calldatas: Hex[];
  description: string;
}

interface QueueTransaction {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  chainId: number;
  data?: Hex;
  logs?: Log[];
  descriptionHash: Hex;
}

// Helper function to extract params from text
function extractQueueGovernanceParamsFromText(text: string): Partial<QueueGovernanceParams> {
  const params: Partial<QueueGovernanceParams> = {};
  logger.debug(`Attempting to extract QueueGovernanceParams from text: "${text}"`);

  // Reuse extraction logic similar to propose, as params are nearly identical
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

  logger.debug('Manually extracted QueueGovernanceParams:', params);
  return params;
}

class PolygonQueueGovernanceActionRunner {
  constructor(private walletProvider: WalletProvider) {}

  async queue(params: QueueGovernanceParams): Promise<QueueTransaction> {
    const walletClient = this.walletProvider.getWalletClient(params.chain);
    const publicClient = this.walletProvider.getPublicClient(params.chain);
    const chainConfig = this.walletProvider.getChainConfigs(params.chain);

    if (!walletClient.account) {
      throw new Error('Wallet client account is not available.');
    }
    const senderAddress = walletClient.account.address;

    const numericValues = params.values.map((v) => BigInt(v));
    const descriptionHash = keccak256(stringToHex(params.description));

    const txData = encodeFunctionData({
      abi: governorQueueAbi,
      functionName: 'queue',
      args: [params.targets, numericValues, params.calldatas, descriptionHash],
    });
    logger.debug(
      `Queueing proposal on ${params.chain} at governor ${params.governorAddress} with descHash: ${descriptionHash} (from: "${params.description}")`
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
        value: BigInt(0),
        data: txData,
        chain: chainConfig as Chain,
        kzg,
      });
      logger.info(`Queue transaction sent. Hash: ${hash}. Waiting for receipt...`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return {
        hash,
        from: senderAddress,
        to: params.governorAddress,
        value: BigInt(0),
        data: txData,
        chainId: chainConfig.id,
        logs: receipt.logs as Log[],
        descriptionHash,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Governance queue failed: ${errMsg}`, error);
      throw new Error(`Governance queue failed: ${errMsg}`);
    }
  }
}

export const queueGovernanceAction: Action = {
  name: 'POLYGON_QUEUE_GOVERNANCE',
  similes: ['GOV_QUEUE', 'SCHEDULE_PROPOSAL'].map((s) => `POLYGON_${s}`),
  description: 'Queues a passed governance proposal for execution on Polygon.',
  validate: async (runtime: IAgentRuntime, _m: Memory, _s: State | undefined): Promise<boolean> => {
    logger.debug('Validating POLYGON_QUEUE_GOVERNANCE action...');
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
    logger.info('Handling POLYGON_QUEUE_GOVERNANCE for message:', message.id);
    const rawMessageText = message.content.text || '';
    let extractedParams: (Partial<QueueGovernanceParams> & { error?: string }) | null = null;

    try {
      const walletProvider = await initWalletProvider(runtime);
      const actionRunner = new PolygonQueueGovernanceActionRunner(walletProvider);

      const prompt = composePromptFromState({
        state,
        template: queueGovernanceActionTemplate,
      });

      const modelResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      try {
        const parsed = parseJSONObjectFromText(modelResponse);
        if (parsed) {
          extractedParams = parsed as Partial<QueueGovernanceParams> & {
            error?: string;
          };
        }
        logger.debug('POLYGON_QUEUE_GOVERNANCE: Extracted params via TEXT_SMALL:', extractedParams);

        if (extractedParams?.error) {
          logger.warn(
            `POLYGON_QUEUE_GOVERNANCE: Model responded with error: ${extractedParams.error}`
          );
          throw new Error(extractedParams.error);
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.warn(
          `POLYGON_QUEUE_GOVERNANCE: Failed to parse JSON from model response or model returned error (Proceeding to manual extraction): ${errorMsg}`
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
          'POLYGON_QUEUE_GOVERNANCE: Model extraction insufficient, attempting manual parameter extraction from text.'
        );
        const manualParams = extractQueueGovernanceParamsFromText(rawMessageText);

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
          'POLYGON_QUEUE_GOVERNANCE: Params after manual extraction attempt:',
          extractedParams
        );
      }

      if (
        !extractedParams?.chain ||
        !extractedParams.governorAddress ||
        !extractedParams.targets ||
        !(extractedParams.targets.length > 0) ||
        !extractedParams.values ||
        !(extractedParams.values.length > 0) ||
        !extractedParams.calldatas ||
        !(extractedParams.calldatas.length > 0) ||
        !extractedParams.description
      ) {
        logger.error(
          'POLYGON_QUEUE_GOVERNANCE: Invalid or incomplete parameters after all extraction attempts.',
          extractedParams
        );
        throw new Error('Invalid or incomplete governance queue parameters.');
      }

      const queueParams: QueueGovernanceParams = {
        chain: (extractedParams.chain || 'polygon') as string,
        governorAddress: extractedParams.governorAddress as Address,
        targets: (extractedParams.targets || []) as Address[],
        values: (extractedParams.values || []) as string[],
        calldatas: (extractedParams.calldatas || []) as Hex[],
        description: extractedParams.description || '',
      };

      if (
        !queueParams.governorAddress ||
        !queueParams.description ||
        queueParams.targets.length === 0 ||
        queueParams.targets.length !== queueParams.values.length ||
        queueParams.targets.length !== queueParams.calldatas.length
      ) {
        logger.error(
          'POLYGON_QUEUE_GOVERNANCE: Invalid or incomplete parameters after all extraction attempts.',
          queueParams
        );
        throw new Error('Invalid or incomplete governance queue parameters.');
      }

      logger.debug('Queue governance parameters for runner:', queueParams);
      const txResult = await actionRunner.queue(queueParams);
      const successMsg = `Successfully queued proposal on ${queueParams.chain} for governor ${queueParams.governorAddress} (Desc: "${queueParams.description}", Hash: ${txResult.descriptionHash}). TxHash: ${txResult.hash}`;
      logger.info(successMsg);

      if (callback) {
        await callback({
          text: successMsg,
          content: { success: true, ...txResult },
          actions: ['POLYGON_QUEUE_GOVERNANCE'],
          source: message.content.source,
        });
      }
      return { success: true, ...txResult };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Error in QUEUE_GOVERNANCE_POLYGON handler: ${errMsg}`, error);
      if (callback) {
        await callback({
          text: `Error queuing governance proposal: ${errMsg}`,
          actions: ['POLYGON_QUEUE_GOVERNANCE'],
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
          text: "Queue the proposal 'Test Prop Q1' on Polygon governor 0xGov. Chain: polygon. Targets: [0xT1], Values: [0], Calldatas: [0xCD1]. Description: Test Description for Q1.",
        },
      },
    ],
  ],
};
