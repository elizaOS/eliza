import { elizaLogger, type IAgentRuntime } from '@elizaos/core';
import { BaseNearService } from './base/BaseService';
import { WalletService } from './WalletService';
import { StorageService } from './StorageService';
import { NearPluginError, NearErrorCode } from '../core/errors';
import { utils } from 'near-api-js';

/**
 * Escrow service for handling multi-party transactions
 * Supports bets, trades, and conditional payments
 */
export interface EscrowContract {
  id: string;
  type: 'bet' | 'trade' | 'conditional_payment';
  parties: {
    address: string;
    deposit: string; // In NEAR
    condition?: string; // What needs to happen for them to win
    approved: boolean;
  }[];
  arbiter?: string; // Optional arbiter address
  description: string;
  terms: {
    winCondition: string;
    deadline: number;
    autoResolve?: boolean;
  };
  state: 'pending' | 'active' | 'resolved' | 'cancelled';
  winner?: string;
  createdAt: number;
  resolvedAt?: number;
  totalAmount: string;
}

export interface BetIntent {
  type: 'escrow_bet';
  parties: Array<{
    address: string;
    stake: string;
    prediction: any;
  }>;
  condition: string;
  deadline: number;
  arbiter?: string;
}

export class EscrowService extends BaseNearService {
  capabilityDescription = 'Manages escrow contracts for bets, trades, and conditional payments';

  private walletService!: WalletService;
  private storageService!: StorageService;
  private activeContracts: Map<string, EscrowContract> = new Map();

  async onInitialize(): Promise<void> {
    const walletService = this.runtime.getService<WalletService>('near-wallet' as any);
    const storageService = this.runtime.getService<StorageService>('near-storage' as any);

    if (!walletService || !storageService) {
      throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Required services not available');
    }

    this.walletService = walletService;
    this.storageService = storageService;

    // Load active escrow contracts
    await this.loadActiveContracts();

    elizaLogger.info('Escrow service initialized');
  }

  private async loadActiveContracts(): Promise<void> {
    try {
      const contractIds = (await this.storageService.get('escrow:active')) || [];

      for (const contractId of contractIds) {
        const contract = await this.storageService.get(`escrow:${contractId}`);
        if (contract && contract.state !== 'resolved' && contract.state !== 'cancelled') {
          this.activeContracts.set(contractId, contract);
        }
      }
    } catch (error) {
      elizaLogger.warn('Failed to load active escrow contracts', error);
    }
  }

  /**
   * Create a bet escrow between multiple parties
   */
  async createBetEscrow(intent: BetIntent): Promise<string> {
    try {
      const account = await this.walletService.getAccount();

      // Validate all parties have sufficient balance
      for (const party of intent.parties) {
        if (party.address === account.accountId) {
          continue;
        }

        // In a real implementation, we'd check their balances
        // For now, we'll assume they've pre-authorized
      }

      // Calculate total escrow amount
      const totalAmount = intent.parties
        .reduce((sum, party) => sum + parseFloat(party.stake), 0)
        .toString();

      // Create escrow contract
      const contract: EscrowContract = {
        id: `escrow-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        type: 'bet',
        parties: intent.parties.map((party) => ({
          address: party.address,
          deposit: party.stake,
          condition: JSON.stringify(party.prediction),
          approved: party.address === account.accountId,
        })),
        arbiter: intent.arbiter || account.accountId,
        description: `Bet: ${intent.condition}`,
        terms: {
          winCondition: intent.condition,
          deadline: intent.deadline,
          autoResolve: !intent.arbiter,
        },
        state: 'pending',
        createdAt: Date.now(),
        totalAmount,
      };

      // Store contract
      await this.storageService.set(`escrow:${contract.id}`, contract);
      this.activeContracts.set(contract.id, contract);

      // Update active contracts list
      const activeIds = (await this.storageService.get('escrow:active')) || [];
      activeIds.push(contract.id);
      await this.storageService.set('escrow:active', activeIds);

      // If this agent is a party, deposit their stake
      const myParty = contract.parties.find((p) => p.address === account.accountId);
      if (myParty) {
        // In a real implementation, we'd lock these funds
        // For now, we'll just mark it in storage
        await this.storageService.set(`escrow:${contract.id}:deposit:${account.accountId}`, {
          amount: myParty.deposit,
          timestamp: Date.now(),
        });
      }

      elizaLogger.success(`Created bet escrow: ${contract.id}`);
      return contract.id;
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to create bet escrow',
        error
      );
    }
  }

  /**
   * Join an existing escrow contract
   */
  async joinEscrow(contractId: string): Promise<void> {
    try {
      const contract = this.activeContracts.get(contractId);
      if (!contract) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Escrow contract not found');
      }

      const account = await this.walletService.getAccount();
      const myParty = contract.parties.find((p) => p.address === account.accountId);

      if (!myParty) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Not a party to this escrow');
      }

      if (myParty.approved) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Already joined this escrow');
      }

      // Deposit stake
      await this.storageService.set(`escrow:${contract.id}:deposit:${account.accountId}`, {
        amount: myParty.deposit,
        timestamp: Date.now(),
      });

      // Mark as approved
      myParty.approved = true;

      // Check if all parties have joined
      const allApproved = contract.parties.every((p) => p.approved);
      if (allApproved) {
        contract.state = 'active';
      }

      // Update contract
      await this.storageService.set(`escrow:${contract.id}`, contract);

      elizaLogger.success(`Joined escrow: ${contractId}`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to join escrow', error);
    }
  }

  /**
   * Resolve an escrow contract (as arbiter or by consensus)
   */
  async resolveEscrow(contractId: string, winnerId: string): Promise<void> {
    try {
      const contract = this.activeContracts.get(contractId);
      if (!contract) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Escrow contract not found');
      }

      const account = await this.walletService.getAccount();

      // Check if caller is arbiter
      if (contract.arbiter !== account.accountId) {
        throw new NearPluginError(
          NearErrorCode.UNKNOWN_ERROR,
          'Only arbiter can resolve this escrow'
        );
      }

      // Find winner
      const winner = contract.parties.find((p) => p.address === winnerId);
      if (!winner) {
        throw new NearPluginError(
          NearErrorCode.UNKNOWN_ERROR,
          'Winner not found in contract parties'
        );
      }

      // Calculate arbiter fee (2% of total)
      const arbiterFee = parseFloat(contract.totalAmount) * 0.02;
      const winnerAmount = parseFloat(contract.totalAmount) - arbiterFee;

      // In a real implementation, we'd transfer funds here
      // For this demo, we'll record the resolution
      contract.state = 'resolved';
      contract.winner = winnerId;
      contract.resolvedAt = Date.now();

      // Record payouts
      await this.storageService.set(`escrow:${contract.id}:payout`, {
        winner: winnerId,
        amount: winnerAmount.toString(),
        arbiterFee: arbiterFee.toString(),
        timestamp: Date.now(),
      });

      // Update contract
      await this.storageService.set(`escrow:${contract.id}`, contract);
      this.activeContracts.delete(contractId);

      // Update active contracts list
      const activeIds = (await this.storageService.get('escrow:active')) || [];
      const index = activeIds.indexOf(contractId);
      if (index > -1) {
        activeIds.splice(index, 1);
        await this.storageService.set('escrow:active', activeIds);
      }

      elizaLogger.success(`Resolved escrow: ${contractId}, winner: ${winnerId}`);
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to resolve escrow',
        error
      );
    }
  }

  /**
   * Get active escrow contracts
   */
  async getActiveContracts(): Promise<EscrowContract[]> {
    return Array.from(this.activeContracts.values())
      .filter((contract) => contract.state === 'active')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get escrow contract details
   */
  async getContract(contractId: string): Promise<EscrowContract | null> {
    try {
      const contract =
        this.activeContracts.get(contractId) ||
        (await this.storageService.get(`escrow:${contractId}`));

      return contract;
    } catch (error) {
      elizaLogger.warn(`Failed to get escrow contract ${contractId}`, error);
      return null;
    }
  }

  /**
   * Create an intent for complex escrow operations
   */
  async createEscrowIntent(params: {
    type: 'multi_party_bet' | 'conditional_trade';
    parties: Array<{ address: string; conditions: any }>;
    resolution: 'oracle' | 'consensus' | 'arbiter';
  }): Promise<string> {
    try {
      // This would interact with NEAR intents system
      // For now, we'll create a structured intent
      const intent = {
        id: `intent-${Date.now()}`,
        type: 'escrow_intent',
        params,
        createdBy: this.walletService.getAddress(),
        createdAt: Date.now(),
      };

      await this.storageService.set(`intent:${intent.id}`, intent);

      elizaLogger.success(`Created escrow intent: ${intent.id}`);
      return intent.id;
    } catch (error) {
      throw new NearPluginError(
        NearErrorCode.TRANSACTION_FAILED,
        'Failed to create escrow intent',
        error
      );
    }
  }

  /**
   * Cancel an escrow contract (only if pending)
   */
  async cancelEscrow(contractId: string): Promise<void> {
    try {
      const contract = this.activeContracts.get(contractId);
      if (!contract) {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Escrow contract not found');
      }

      if (contract.state !== 'pending') {
        throw new NearPluginError(NearErrorCode.UNKNOWN_ERROR, 'Can only cancel pending contracts');
      }

      const account = await this.walletService.getAccount();

      // Check if caller is a party or arbiter
      const isParty = contract.parties.some((p) => p.address === account.accountId);
      const isArbiter = contract.arbiter === account.accountId;

      if (!isParty && !isArbiter) {
        throw new NearPluginError(
          NearErrorCode.UNKNOWN_ERROR,
          'Not authorized to cancel this escrow'
        );
      }

      // Mark as cancelled
      contract.state = 'cancelled';
      contract.resolvedAt = Date.now();

      // Update storage
      await this.storageService.set(`escrow:${contract.id}`, contract);
      this.activeContracts.delete(contractId);

      elizaLogger.success(`Cancelled escrow: ${contractId}`);
    } catch (error) {
      throw new NearPluginError(NearErrorCode.TRANSACTION_FAILED, 'Failed to cancel escrow', error);
    }
  }

  protected async checkHealth(): Promise<void> {
    // Service is healthy if wallet and storage are available
    await this.walletService.getAccount();
  }

  protected async onCleanup(): Promise<void> {
    // Save active contracts state
    const activeIds = Array.from(this.activeContracts.keys());
    await this.storageService.set('escrow:active', activeIds).catch(() => {});
  }

  static async start(runtime: IAgentRuntime): Promise<EscrowService> {
    const service = new EscrowService();
    await service.initialize(runtime);
    return service;
  }

  async stop(): Promise<void> {
    await this.cleanup();
  }
}
