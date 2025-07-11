import { connect, keyStores, utils, type Near, type Account, type KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js/lib/utils';
import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { NearPluginError, NearErrorCode } from '../core/errors';
import type { NearPluginConfig, WalletInfo, TokenBalance } from '../core/types';
import { NEAR_NETWORKS, MIN_ACCOUNT_BALANCE } from '../core/constants';
import { validateNearConfig } from '../environment';

export class WalletService extends BaseNearService {
  capabilityDescription = 'Manages NEAR wallet operations';

  private near!: Near;
  private keyStore!: keyStores.InMemoryKeyStore;
  private account!: Account;

  async onInitialize(): Promise<void> {
    // Validate and load configuration
    this.config = await validateNearConfig(this.runtime);

    // Initialize key store
    this.keyStore = new keyStores.InMemoryKeyStore();

    // Set up wallet
    await this.setupWallet();

    // Connect to NEAR
    await this.connectToNear();

    // Verify account exists
    await this.verifyAccount();
  }

  private async setupWallet(): Promise<void> {
    try {
      const keyPair = utils.KeyPair.fromString(this.config.NEAR_WALLET_SECRET_KEY as KeyPairString);

      await this.keyStore.setKey(this.config.networkId, this.config.NEAR_ADDRESS, keyPair);

      elizaLogger.info(`Wallet configured for ${this.config.NEAR_ADDRESS}`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'Failed to setup wallet', error);
    }
  }

  private async connectToNear(): Promise<void> {
    try {
      const networkConfig = NEAR_NETWORKS[this.config.NEAR_NETWORK];

      this.near = await connect({
        networkId: this.config.networkId,
        keyStore: this.keyStore,
        nodeUrl: this.config.nodeUrl || networkConfig.nodeUrl,
        walletUrl: networkConfig.walletUrl,
        helperUrl: networkConfig.helperUrl,
      });

      this.account = await this.near.account(this.config.NEAR_ADDRESS);

      elizaLogger.info(`Connected to NEAR ${this.config.networkId}`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.NETWORK_UNAVAILABLE,
        'Failed to connect to NEAR network',
        error
      );
    }
  }

  private async verifyAccount(): Promise<void> {
    try {
      const state = await this.account.state();
      elizaLogger.info(`Account verified: ${this.config.NEAR_ADDRESS}`, {
        balance: utils.format.formatNearAmount(state.amount),
      });
    } catch (error: any) {
      if (error.message?.includes('does not exist')) {
        throw new NearPluginError(
          NearErrorCode.ACCOUNT_NOT_FOUND,
          `Account ${this.config.NEAR_ADDRESS} does not exist`,
          error
        );
      }
      throw new NearPluginError(NearErrorCode.RPC_ERROR, 'Failed to verify account', error);
    }
  }

  async getAccount(): Promise<Account> {
    if (!this.account) {
      throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'Wallet not initialized');
    }
    return this.account;
  }

  async getNear(): Promise<Near> {
    if (!this.near) {
      throw new NearPluginError(NearErrorCode.INVALID_CONFIG, 'NEAR connection not initialized');
    }
    return this.near;
  }

  async getBalance(): Promise<string> {
    try {
      const balance = await this.account.getAccountBalance();
      return balance.available;
    } catch (error) {
      throw new NearPluginError(NearErrorCode.RPC_ERROR, 'Failed to get account balance', error);
    }
  }

  async getWalletInfo(): Promise<WalletInfo> {
    try {
      const balance = await this.getBalance();
      const state = await this.account.state();

      // For now, just return NEAR balance
      // Token balances will be handled by TokenService
      const info: WalletInfo = {
        address: this.config.NEAR_ADDRESS,
        publicKey: this.config.NEAR_WALLET_PUBLIC_KEY,
        balance,
        tokens: [
          {
            token: {
              id: 'NEAR',
              symbol: 'NEAR',
              name: 'NEAR Protocol',
              decimals: 24,
            },
            amount: balance,
            humanAmount: utils.format.formatNearAmount(balance),
          },
        ],
        totalValueUsd: 0, // Will be calculated by PriceService
      };

      return info;
    } catch (error) {
      throw new NearPluginError(NearErrorCode.RPC_ERROR, 'Failed to get wallet info', error);
    }
  }

  async hasEnoughBalance(amount: string, includeGas: boolean = true): Promise<boolean> {
    try {
      const balance = await this.getBalance();
      const required = BigInt(amount);
      const available = BigInt(balance);

      if (includeGas) {
        // Keep minimum balance for storage
        const minBalance = BigInt(utils.format.parseNearAmount(MIN_ACCOUNT_BALANCE) || '0');
        return available - minBalance >= required;
      }

      return available >= required;
    } catch (error) {
      elizaLogger.error('Error checking balance:', error);
      return false;
    }
  }

  async checkHealth(): Promise<void> {
    try {
      await this.account.state();
    } catch (error) {
      throw new NearPluginError(NearErrorCode.RPC_ERROR, 'Health check failed', error);
    }
  }

  protected async onCleanup(): Promise<void> {
    // Clear sensitive data
    if (this.keyStore) {
      await this.keyStore.clear();
    }
  }

  // Getters for configuration
  getNetwork(): 'mainnet' | 'testnet' {
    return this.config.NEAR_NETWORK;
  }

  getAddress(): string {
    return this.config.NEAR_ADDRESS;
  }

  getExplorerUrl(txHash?: string): string {
    const baseUrl = NEAR_NETWORKS[this.config.NEAR_NETWORK].explorerUrl;
    if (txHash) {
      return `${baseUrl}/transactions/${txHash}`;
    }
    return `${baseUrl}/accounts/${this.config.NEAR_ADDRESS}`;
  }

  static async start(runtime: IAgentRuntime): Promise<WalletService> {
    const service = new WalletService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
