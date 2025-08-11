import type { OfflineSigner } from '@cosmjs/proto-signing';
import { DirectSecp256k1HdWallet, coins, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import type { SigningStargateClient, StargateClientOptions } from '@cosmjs/stargate';
import { SigningStargateClient as ConcreteSigningStargateClient } from '@cosmjs/stargate';
import { Service, type IAgentRuntime, logger } from '@elizaos/core';

// Configuration keys expected from the runtime settings
const HEIMDALL_RPC_URL_KEY = 'HEIMDALL_RPC_URL';
const PRIVATE_KEY_KEY = 'PRIVATE_KEY';

// Interface for cosmos sdk transaction return type
interface BroadcastTxSuccess {
  code: number;
  height: number;
  rawLog: string;
  transactionHash: string;
  gasUsed: number;
  gasWanted: number;
}

/**
 * Service for interacting with the Polygon Heimdall layer,
 * primarily for token transfer operations.
 */
export class HeimdallService extends Service {
  static override serviceType = 'heimdall';
  override capabilityDescription =
    'Provides access to Polygon Heimdall layer for token transfer operations.';

  private heimdallRpcUrl: string | null = null;
  private privateKey: string | null = null;

  // Fee defaults for Heimdall transactions in MATIC - can be made configurable if needed
  private static readonly DEFAULT_GAS_LIMIT = '200000';
  private static readonly DEFAULT_FEE_AMOUNT = '5000000000000000'; // 0.005 MATIC
  private static readonly DEFAULT_DENOM = 'matic';

  // initializeHeimdallClient will be called by the static start method
  private async initializeHeimdallClient(): Promise<void> {
    if (!this.runtime) {
      logger.error('Agent runtime is not available for HeimdallService.');
      throw new Error('Agent runtime not available.');
    }

    this.heimdallRpcUrl = this.runtime.getSetting(HEIMDALL_RPC_URL_KEY);
    this.privateKey = this.runtime.getSetting(PRIVATE_KEY_KEY);

    if (!this.heimdallRpcUrl) {
      logger.error(`Heimdall RPC URL setting (${HEIMDALL_RPC_URL_KEY}) not found.`);
      throw new Error('Heimdall RPC URL is not configured.');
    }
    if (!this.privateKey) {
      logger.error(`Heimdall private key setting (${PRIVATE_KEY_KEY}) not found.`);
      throw new Error('Heimdall private key is not configured.');
    }
    logger.info('HeimdallService initialized with necessary configurations.');
  }

  static async start(runtime: IAgentRuntime): Promise<HeimdallService> {
    logger.info('Starting HeimdallService...');
    const service = new HeimdallService(runtime);
    await service.initializeHeimdallClient();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping HeimdallService...');
    const service = runtime.getService<HeimdallService>(HeimdallService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    logger.info('HeimdallService instance stopped.');
    this.heimdallRpcUrl = null;
    this.privateKey = null;
  }

  private async getSigner(): Promise<OfflineSigner> {
    if (!this.privateKey) {
      logger.error('Heimdall private key is not available in getSigner.');
      throw new Error('Heimdall private key is not configured for HeimdallService.');
    }
    try {
      // Convert hex private key to Uint8Array
      // Ensure the private key starts with 0x for consistency, then strip it for Buffer conversion
      const hexKey = this.privateKey.startsWith('0x')
        ? this.privateKey.substring(2)
        : this.privateKey;
      if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
        logger.error('Invalid private key format. Expected 64 hex characters.');
        throw new Error('Invalid private key format.');
      }
      const privateKeyBytes = Uint8Array.from(Buffer.from(hexKey, 'hex'));

      const signer = await DirectSecp256k1Wallet.fromKey(privateKeyBytes, 'heimdall');
      return signer;
    } catch (error) {
      logger.error(
        'Failed to create Heimdall signer from private key.',
        error instanceof Error ? error.message : String(error)
      );
      throw new Error('Failed to create Heimdall signer.');
    }
  }

  public async getSigningClient(): Promise<SigningStargateClient> {
    if (!this.heimdallRpcUrl) {
      logger.error('Heimdall RPC URL is not available in getSigningClient.');
      throw new Error('Heimdall RPC URL is not configured for HeimdallService.');
    }

    try {
      const signer = await this.getSigner();
      const options: StargateClientOptions = {};
      const client = await ConcreteSigningStargateClient.connectWithSigner(
        this.heimdallRpcUrl,
        signer,
        options
      );
      logger.debug('Successfully connected to Heimdall RPC with signer.');
      return client;
    } catch (error) {
      logger.error(
        'Failed to connect to Heimdall RPC with signer.',
        error instanceof Error ? error.message : String(error)
      );
      throw new Error('Failed to connect to Heimdall RPC with signer.');
    }
  }

  /**
   * Asserts that a transaction was successful by checking its code.
   * @param result The broadcast tx result to check
   * @throws Error if the transaction failed
   */
  private assertIsBroadcastTxSuccess(result: {
    code?: number;
    rawLog?: string;
  }): asserts result is BroadcastTxSuccess {
    if ('code' in result && result.code !== 0) {
      const message = result.rawLog || 'Transaction failed';
      throw new Error(`Error when broadcasting tx: ${message}`);
    }
  }

  public async transferHeimdallTokens(
    recipientAddress: string,
    amount: string,
    denom = 'matic'
  ): Promise<string> {
    logger.info(`Attempting to transfer ${amount} ${denom} to ${recipientAddress} on Heimdall`);

    try {
      // Step 1: Get the signing client and first account/signer
      const client = await this.getSigningClient();
      const signer = await this.getSigner();
      const accounts = await signer.getAccounts();
      if (accounts.length === 0) {
        throw new Error('No accounts found in wallet');
      }
      const sender = accounts[0].address;
      logger.debug(`Sender address: ${sender}`);

      // Validate recipient address
      if (!recipientAddress.startsWith('heimdall')) {
        throw new Error(
          `Invalid recipient address format: ${recipientAddress}. Must start with "heimdall"`
        );
      }

      // Step 2: Construct the MsgSend for token transfer
      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: sender,
          toAddress: recipientAddress,
          amount: coins(amount, denom),
        },
      };

      // Step 3: Prepare fee
      const fee = {
        amount: coins(HeimdallService.DEFAULT_FEE_AMOUNT, HeimdallService.DEFAULT_DENOM),
        gas: HeimdallService.DEFAULT_GAS_LIMIT,
      };

      // Step 4: Broadcast the transaction
      logger.debug(`Broadcasting transfer transaction to ${recipientAddress}...`);
      const result = await client.signAndBroadcast(sender, [msgSend], fee);

      // Step 5: Check for success and return tx hash
      this.assertIsBroadcastTxSuccess(result);
      logger.info(
        `Successfully transferred ${amount} ${denom} to ${recipientAddress}, tx hash: ${result.transactionHash}`
      );
      return result.transactionHash;
    } catch (error) {
      // Convert error to a more user-friendly format
      let errorMessage: string;
      if (error instanceof Error) {
        errorMessage = error.message;
        // Add more specific error handling
        if (errorMessage.includes('insufficient fee')) {
          errorMessage =
            'Insufficient fee for Heimdall transaction. Try increasing the fee amount.';
        } else if (errorMessage.includes('insufficient funds')) {
          errorMessage = `Insufficient funds to transfer ${amount} ${denom}. Check your balance on Heimdall.`;
        }
      } else {
        errorMessage = String(error);
      }

      logger.error(`Failed to transfer tokens to ${recipientAddress}:`, errorMessage);
      throw new Error(`Transfer failed: ${errorMessage}`);
    }
  }
}
