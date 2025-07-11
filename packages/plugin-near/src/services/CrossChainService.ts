import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { NearPluginError, NearErrorCode } from '../core/errors';
import { utils } from 'near-api-js';

/**
 * Real implementation focusing on NEAR's actual cross-chain capabilities:
 * - Aurora (Ethereum) bridge
 * - Rainbow Bridge for ETH/ERC-20 tokens
 *
 * Note: Bitcoin, Solana support are future features not yet available
 */
export class CrossChainService extends BaseNearService {
  capabilityDescription = 'Manages cross-chain operations via Aurora and Rainbow Bridge';

  private walletService!: WalletService;
  private auroraContract = 'aurora';
  private rainbowBridgeContract = 'factory.bridge.near';

  async onInitialize(): Promise<void> {
    const walletService = this.runtime.getService<WalletService>('near-wallet' as any);
    if (!walletService) {
      throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Wallet service not available');
    }
    this.walletService = walletService;

    // Set contract addresses based on network
    const network = this.walletService.getNetwork();
    if (network === 'testnet') {
      this.auroraContract = 'aurora';
      this.rainbowBridgeContract = 'factory.bridge.testnet';
    }

    elizaLogger.info('Cross-chain service initialized for Aurora/Ethereum bridge');
  }

  /**
   * Transfer tokens to Aurora (Ethereum on NEAR)
   */
  async transferToAurora(tokenId: string, amount: string, auroraAddress: string): Promise<string> {
    try {
      const account = await this.walletService.getAccount();

      // For native NEAR -> Aurora ETH
      if (tokenId === 'NEAR') {
        const result = await account.functionCall({
          contractId: this.auroraContract,
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: auroraAddress,
            amount: utils.format.parseNearAmount(amount) || '0',
            memo: 'Transfer to Aurora',
            msg: '',
          },
          gas: 100000000000000n, // 100 TGas
          attachedDeposit: 1n,
        });

        elizaLogger.success(`Transferred ${amount} NEAR to Aurora: ${result.transaction.hash}`);
        return result.transaction.hash;
      }

      // For other tokens, use the token contract
      const result = await account.functionCall({
        contractId: tokenId,
        methodName: 'ft_transfer_call',
        args: {
          receiver_id: this.auroraContract,
          amount,
          memo: `Transfer to Aurora: ${auroraAddress}`,
          msg: auroraAddress,
        },
        gas: 100000000000000n,
        attachedDeposit: 1n,
      });

      return result.transaction.hash;
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to transfer to Aurora',
        error
      );
    }
  }

  /**
   * Bridge tokens to Ethereum via Rainbow Bridge
   */
  async bridgeToEthereum(
    tokenId: string,
    amount: string,
    ethereumAddress: string
  ): Promise<string> {
    try {
      const account = await this.walletService.getAccount();

      // Use Rainbow Bridge connector
      const result = await account.functionCall({
        contractId: this.rainbowBridgeContract,
        methodName: 'lock',
        args: {
          token: tokenId,
          amount,
          recipient: ethereumAddress,
        },
        gas: 200000000000000n, // 200 TGas
        attachedDeposit: BigInt(utils.format.parseNearAmount('0.01') || '0'), // Bridge fee
      });

      elizaLogger.success(`Bridged ${amount} ${tokenId} to Ethereum: ${result.transaction.hash}`);
      return result.transaction.hash;
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to bridge to Ethereum',
        error
      );
    }
  }

  /**
   * Get status of a bridge transaction
   */
  async getBridgeStatus(txHash: string): Promise<string> {
    try {
      // Query NEAR transaction status first
      const account = await this.walletService.getAccount();
      const near = await this.walletService.getNear();

      try {
        // Check if this is a NEAR transaction hash
        const txStatus = await near.connection.provider.txStatus(
          txHash,
          this.walletService.getAddress(),
          'FINAL'
        );

        if (txStatus && txStatus.status) {
          const status = txStatus.status as any;
          if (status.SuccessValue !== undefined) {
            // Transaction succeeded, check if it's a bridge transaction
            // by looking at the receiver and method
            const actions = txStatus.transaction.actions;
            for (const action of actions) {
              if ('FunctionCall' in action) {
                const functionCall = action.FunctionCall;
                if (
                  functionCall.method_name === 'ft_transfer_call' &&
                  txStatus.transaction.receiver_id.includes('aurora')
                ) {
                  return 'bridged';
                }
              }
            }
            return 'completed';
          } else if (status.Failure) {
            return 'failed';
          }
        }
      } catch (error) {
        // Not a NEAR transaction, might be Aurora/Ethereum
        elizaLogger.info('Transaction not found on NEAR, checking Aurora');
      }

      // For Aurora transactions, we would need to query Aurora RPC
      // This is a simplified implementation
      return 'pending';
    } catch (error) {
      elizaLogger.error('Failed to get bridge status:', error);
      return 'unknown';
    }
  }

  /**
   * Get supported chains (currently only Ethereum via Aurora/Rainbow)
   */
  async getSupportedChains(): Promise<string[]> {
    return ['ethereum', 'aurora'];
  }

  /**
   * Estimate bridge fees
   */
  async estimateBridgeFee(
    fromChain: string,
    toChain: string,
    tokenId: string,
    amount: string
  ): Promise<string> {
    // Simplified fee estimation
    if (fromChain === 'near' && toChain === 'ethereum') {
      return '0.01'; // 0.01 NEAR for Rainbow Bridge
    } else if (fromChain === 'near' && toChain === 'aurora') {
      return '0.001'; // 0.001 NEAR for Aurora transfer
    }

    throw new NearPluginError(
      NearErrorCode.UNKNOWN_ERROR,
      `Unsupported bridge route: ${fromChain} -> ${toChain}`
    );
  }

  protected async checkHealth(): Promise<void> {
    try {
      const account = await this.walletService.getAccount();

      // Check Aurora contract is accessible
      await account.viewFunction({
        contractId: this.auroraContract,
        methodName: 'get_chain_id',
        args: {},
      });
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.RPC_ERROR,
        'Cross-chain service health check failed',
        error
      );
    }
  }

  protected async onCleanup(): Promise<void> {
    // No cleanup needed
  }

  static async start(runtime: IAgentRuntime): Promise<CrossChainService> {
    const service = new CrossChainService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
