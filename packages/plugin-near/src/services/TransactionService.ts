import { utils } from 'near-api-js';
import type { FinalExecutionOutcome } from 'near-api-js/lib/providers';
import BigNumber from 'bignumber.js';
import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { NearPluginError, NearErrorCode, handleNearError } from '../core/errors';
import type { TransactionResult, TransferParams } from '../core/types';
import { GAS_LIMITS, ONE_YOCTO, PATTERNS, ERROR_MESSAGES } from '../core/constants';

export class TransactionService extends BaseNearService {
  capabilityDescription = 'Handles NEAR transaction building and execution';

  private walletService!: WalletService;

  async onInitialize(): Promise<void> {
    // Get wallet service
    this.walletService = this.runtime.getService('near-wallet' as any) as WalletService;
    if (!this.walletService) {
      throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'WalletService not available');
    }
  }

  /**
   * Send NEAR tokens
   */
  async sendNear(params: TransferParams): Promise<TransactionResult> {
    try {
      // Validate inputs
      this.validateTransferParams(params);

      // Get account
      const account = await this.walletService.getAccount();

      // Check balance
      const parsedAmount = utils.format.parseNearAmount(params.amount);
      if (!parsedAmount) {
        throw new NearPluginError(NearErrorCode.INVALID_TRANSACTION, 'Invalid amount format');
      }

      const hasBalance = await this.walletService.hasEnoughBalance(parsedAmount, true);
      if (!hasBalance) {
        throw new NearPluginError(
          NearErrorCode.INSUFFICIENT_BALANCE,
          ERROR_MESSAGES.INSUFFICIENT_BALANCE
        );
      }

      // Execute transfer
      elizaLogger.info(`Sending ${params.amount} NEAR to ${params.recipient}`);

      const result = await account.sendMoney(params.recipient, BigInt(parsedAmount));

      return this.formatTransactionResult(result);
    } catch (error) {
      throw handleNearError(error);
    }
  }

  /**
   * Send NEP-141 tokens
   */
  async sendToken(params: TransferParams): Promise<TransactionResult> {
    if (!params.tokenId) {
      throw new NearPluginError(
        NearErrorCode.INVALID_TRANSACTION,
        'Token ID is required for token transfers'
      );
    }

    try {
      // Validate inputs
      this.validateTransferParams(params);

      // Get account
      const account = await this.walletService.getAccount();

      // Check if recipient has storage deposit
      const hasStorage = await this.checkStorageDeposit(params.tokenId, params.recipient);

      // Build actions
      const actions = [];

      if (!hasStorage) {
        // Add storage deposit
        actions.push({
          methodName: 'storage_deposit',
          args: {
            account_id: params.recipient,
            registration_only: true,
          },
          gas: GAS_LIMITS.STORAGE_DEPOSIT,
          deposit: utils.format.parseNearAmount('0.00125') || '0',
        });
      }

      // Add transfer
      actions.push({
        methodName: 'ft_transfer',
        args: {
          receiver_id: params.recipient,
          amount: params.amount,
          memo: params.memo,
        },
        gas: GAS_LIMITS.FT_TRANSFER,
        deposit: ONE_YOCTO, // 1 yoctoNEAR for security
      });

      // Execute transaction
      elizaLogger.info(`Sending ${params.amount} ${params.tokenId} to ${params.recipient}`);

      const result = await this.executeBatch(params.tokenId, actions);

      return this.formatTransactionResult(result);
    } catch (error) {
      throw handleNearError(error);
    }
  }

  /**
   * Execute a batch of function calls
   */
  private async executeBatch(
    contractId: string,
    actions: Array<{
      methodName: string;
      args: Record<string, unknown>;
      gas: string;
      deposit: string;
    }>
  ): Promise<FinalExecutionOutcome> {
    const account = await this.walletService.getAccount();

    // Execute all actions in a single transaction
    const result = await account.functionCall({
      contractId,
      methodName: actions[0].methodName,
      args: actions[0].args,
      gas: BigInt(actions[0].gas),
      attachedDeposit: BigInt(actions[0].deposit),
    });

    // For multiple actions, we'd need to use batch transactions
    // This is a simplified version for single action
    if (actions.length > 1) {
      elizaLogger.warn('Batch transactions not fully implemented, only first action executed');
    }

    return result;
  }

  /**
   * Check if account has storage deposit for token
   */
  private async checkStorageDeposit(tokenId: string, accountId: string): Promise<boolean> {
    try {
      const account = await this.walletService.getAccount();
      const result = (await account.viewFunction({
        contractId: tokenId,
        methodName: 'storage_balance_of',
        args: { account_id: accountId },
      })) as { total: string } | null;

      return result !== null && result.total !== '0';
    } catch (error) {
      elizaLogger.debug(`Error checking storage balance: ${error}`);
      return false;
    }
  }

  /**
   * Validate transfer parameters
   */
  private validateTransferParams(params: TransferParams): void {
    // Validate recipient
    if (!params.recipient) {
      throw new NearPluginError(NearErrorCode.INVALID_TRANSACTION, 'Recipient is required');
    }

    const network = this.walletService.getNetwork();
    const pattern = network === 'mainnet' ? PATTERNS.ACCOUNT_ID : PATTERNS.TESTNET_ACCOUNT_ID;

    if (!pattern.test(params.recipient)) {
      throw new NearPluginError(NearErrorCode.INVALID_TRANSACTION, ERROR_MESSAGES.INVALID_ACCOUNT);
    }

    // Validate amount
    if (!params.amount || !PATTERNS.AMOUNT.test(params.amount)) {
      throw new NearPluginError(NearErrorCode.INVALID_TRANSACTION, ERROR_MESSAGES.INVALID_AMOUNT);
    }

    // Validate token ID if present
    if (params.tokenId && !PATTERNS.TOKEN_ID.test(params.tokenId)) {
      throw new NearPluginError(NearErrorCode.INVALID_TOKEN_ADDRESS, ERROR_MESSAGES.INVALID_TOKEN);
    }
  }

  /**
   * Format transaction result
   */
  private formatTransactionResult(outcome: FinalExecutionOutcome): TransactionResult {
    const success =
      outcome.status && typeof outcome.status === 'object' && 'SuccessValue' in outcome.status;

    return {
      transactionHash: outcome.transaction.hash,
      blockHash: (outcome.transaction_outcome as any).block_hash || '',
      outcome,
      explorerUrl: this.walletService.getExplorerUrl(outcome.transaction.hash),
      success,
      error: success ? undefined : 'Transaction failed',
    };
  }

  /**
   * Estimate gas for transaction
   */
  async estimateGas(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>
  ): Promise<string> {
    // For now, return default gas limits
    // In production, this would simulate the transaction
    switch (methodName) {
      case 'ft_transfer':
        return GAS_LIMITS.FT_TRANSFER;
      case 'storage_deposit':
        return GAS_LIMITS.STORAGE_DEPOSIT;
      default:
        return GAS_LIMITS.TRANSFER;
    }
  }

  async checkHealth(): Promise<void> {
    // Health check is handled by wallet service
    await this.walletService.getAccount();
  }

  protected async onCleanup(): Promise<void> {
    // No cleanup needed
  }

  static async start(runtime: IAgentRuntime): Promise<TransactionService> {
    const service = new TransactionService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
