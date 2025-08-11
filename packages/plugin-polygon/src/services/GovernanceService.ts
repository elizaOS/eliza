import { Service, IAgentRuntime, logger } from '@elizaos/core';
import { Contract } from 'ethers';
import { type Address, type Hash } from 'viem';
import { PolygonRpcService } from './PolygonRpcService';

// Import ABIs
import VoteTokenABI from '../contracts/VoteTokenABI.json' with { type: "json" };
import OZGovernorABI from '../contracts/OZGovernorABI.json' with { type: "json" };
import TimelockControllerABI from '../contracts/TimelockControllerABI.json' with { type: "json" };

// Types for governance
export interface ProposalVotes {
  againstVotes: bigint;
  forVotes: bigint;
  abstainVotes: bigint;
}

export enum ProposalState {
  Pending,
  Active,
  Canceled,
  Defeated,
  Succeeded,
  Queued,
  Expired,
  Executed
}

export interface ProposalInfo {
  id: bigint;
  proposer: Address;
  description: string;
  status: ProposalState;
  votingStarts: Date;
  votingEnds: Date;
  votes: ProposalVotes;
}

export interface GovernanceSettings {
  votingDelay: bigint;
  votingPeriod: bigint;
  proposalThreshold: bigint;
  quorum: bigint;
}

/**
 * Service for interacting with governance contracts on Polygon
 */
export class GovernanceService extends Service {
  static serviceType = 'polygonGovernance';
  capabilityDescription =
    'Provides access to governance functionality on Polygon';

  // Contract addresses
  private governorAddress: Address | null = null;
  private tokenAddress: Address | null = null;
  private timelockAddress: Address | null = null;

  // Contract instances
  private governorContract: Contract | null = null;
  private tokenContract: Contract | null = null;
  private timelockContract: Contract | null = null;
  
  // RPC Service for blockchain interactions
  private rpcService: PolygonRpcService | null = null;
  
  // Cache settings
  private cacheKey = 'polygon/governance';
  private cacheExpiryMs = 60000; // 1 minute

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  /**
   * Initializes the governance contracts
   */
  private async initializeContracts(): Promise<void> {
    if (!this.runtime) {
      throw new Error('Runtime required for contract initialization');
    }

    try {
      // Get contract addresses from settings
      this.governorAddress = this.runtime.getSetting('GOVERNOR_ADDRESS') as Address || '0xD952175d6A20187d7A5803DcC9741472F640A9b8';
      this.tokenAddress = this.runtime.getSetting('TOKEN_ADDRESS') as Address;
      this.timelockAddress = this.runtime.getSetting('TIMELOCK_ADDRESS') as Address;
      
      if (!this.governorAddress) {
        throw new Error('Governor address is required');
      }
      
      // If token or timelock addresses are not provided, try to get them from the governor contract
      this.rpcService = this.runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!this.rpcService) {
        throw new Error('PolygonRpcService not available');
      }
      
      // Initialize ethers contracts using the RPC provider's ethers provider
      const l2Provider = this.rpcService.getEthersProvider('L2');
      if (!l2Provider) {
        throw new Error('L2 provider not available');
      }
      
      // Initialize governor contract first
      this.governorContract = new Contract(this.governorAddress, OZGovernorABI, l2Provider);
      
      // If token address is not provided, try to get it from the governor contract
      if (!this.tokenAddress) {
        try {
          this.tokenAddress = await this.governorContract.token() as Address;
          logger.info(`Retrieved token address from governor: ${this.tokenAddress}`);
        } catch (error) {
          logger.error('Failed to get token address from governor contract:', error);
          throw new Error('Token address not provided and could not be retrieved from governor');
        }
      }
      
      // Initialize token contract
      this.tokenContract = new Contract(this.tokenAddress, VoteTokenABI, l2Provider);
      
      // If timelock address is not provided, use the governor's timelock if available
      if (!this.timelockAddress) {
        try {
          // Note: This assumes the governor contract has a timelock() method
          // If not available, this will fail and we'll throw an appropriate error
          this.timelockAddress = await this.governorContract.timelock() as Address;
          logger.info(`Retrieved timelock address from governor: ${this.timelockAddress}`);
        } catch (error) {
          logger.error('Failed to get timelock address from governor contract:', error);
          throw new Error('Timelock address not provided and could not be retrieved from governor');
        }
      }
      
      // Initialize timelock contract
      this.timelockContract = new Contract(this.timelockAddress, TimelockControllerABI, l2Provider);
      
      logger.info('GovernanceService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize GovernanceService:', error);
      // Reset all components on failure
      this.governorAddress = null;
      this.tokenAddress = null;
      this.timelockAddress = null;
      this.governorContract = null;
      this.tokenContract = null;
      this.timelockContract = null;
      throw error;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<GovernanceService> {
    logger.info(`Starting GovernanceService...`);
    const service = new GovernanceService(runtime);
    await service.initializeContracts();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping GovernanceService...');
    const service = runtime.getService<GovernanceService>(GovernanceService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    logger.info('GovernanceService instance stopped.');
    this.governorContract = null;
    this.tokenContract = null;
    this.timelockContract = null;
  }

  /**
   * Gets the governance token information
   */
  async getTokenInfo(): Promise<{ name: string; symbol: string; decimals: number; totalSupply: bigint }> {
    try {
      if (!this.tokenContract) {
        throw new Error('Token contract not initialized');
      }
      
      const [name, symbol, decimals, totalSupply] = await Promise.all([
        this.tokenContract.name(),
        this.tokenContract.symbol(),
        this.tokenContract.decimals(),
        this.tokenContract.totalSupply()
      ]);
      
      return {
        name,
        symbol,
        decimals,
        totalSupply
      };
    } catch (error) {
      logger.error('Error getting token info:', error);
      throw new Error(`Failed to get token info: ${error.message}`);
    }
  }

  /**
   * Gets the governance settings
   */
  async getGovernanceSettings(): Promise<GovernanceSettings> {
    try {
      if (!this.governorContract) {
        throw new Error('Governor contract not initialized');
      }
      
      const [votingDelay, votingPeriod, proposalThreshold, quorum] = await Promise.all([
        this.governorContract.votingDelay(),
        this.governorContract.votingPeriod(),
        this.governorContract.proposalThreshold(),
        this.governorContract.quorum(0) // Use block 0 as a placeholder
      ]);
      
      return {
        votingDelay,
        votingPeriod,
        proposalThreshold,
        quorum
      };
    } catch (error) {
      logger.error('Error getting governance settings:', error);
      throw new Error(`Failed to get governance settings: ${error.message}`);
    }
  }

  /**
   * Gets the state of a proposal
   */
  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    try {
      if (!this.governorContract) {
        throw new Error('Governor contract not initialized');
      }
      
      const state = await this.governorContract.state(proposalId);
      return state;
    } catch (error) {
      logger.error(`Error getting proposal state for ${proposalId}:`, error);
      throw new Error(`Failed to get proposal state: ${error.message}`);
    }
  }

  /**
   * Gets the votes for a proposal
   */
  async getProposalVotes(proposalId: bigint): Promise<ProposalVotes> {
    try {
      if (!this.governorContract) {
        throw new Error('Governor contract not initialized');
      }
      
      const [againstVotes, forVotes, abstainVotes] = await this.governorContract.proposalVotes(proposalId);
      
      return {
        againstVotes,
        forVotes,
        abstainVotes
      };
    } catch (error) {
      logger.error(`Error getting proposal votes for ${proposalId}:`, error);
      throw new Error(`Failed to get proposal votes: ${error.message}`);
    }
  }

  /**
   * Gets the voting power of an address
   */
  async getVotingPower(address: Address): Promise<bigint> {
    try {
      if (!this.tokenContract) {
        throw new Error('Token contract not initialized');
      }
      
      const votes = await this.tokenContract.getVotes(address);
      return votes;
    } catch (error) {
      logger.error(`Error getting voting power for ${address}:`, error);
      throw new Error(`Failed to get voting power: ${error.message}`);
    }
  }

  /**
   * Gets the token balance of an address
   */
  async getTokenBalance(address: Address): Promise<bigint> {
    try {
      if (!this.tokenContract) {
        throw new Error('Token contract not initialized');
      }
      
      const balance = await this.tokenContract.balanceOf(address);
      return balance;
    } catch (error) {
      logger.error(`Error getting token balance for ${address}:`, error);
      throw new Error(`Failed to get token balance: ${error.message}`);
    }
  }

  /**
   * Delegate voting power to an address
   */
  async delegate(delegatee: Address): Promise<Hash> {
    try {
      if (!this.rpcService || !this.tokenAddress) {
        throw new Error('Required services or addresses not initialized');
      }
      
      // Encode function call for delegate(address)
      const data = '0x5c19a95c' + delegatee.slice(2).padStart(64, '0');
      
      // Send transaction directly using sendTransaction
      const txHash = await this.rpcService.sendTransaction(
        this.tokenAddress,
        BigInt(0),
        data as Hash,
        'L2'
      );
      
      return txHash;
    } catch (error) {
      logger.error(`Error delegating to ${delegatee}:`, error);
      throw new Error(`Failed to delegate: ${error.message}`);
    }
  }

  /**
   * Gets the timelock controller's minimum delay
   */
  async getMinDelay(): Promise<bigint> {
    try {
      if (!this.timelockContract) {
        throw new Error('Timelock contract not initialized');
      }
      
      const minDelay = await this.timelockContract.getMinDelay();
      return minDelay;
    } catch (error) {
      logger.error('Error getting minimum delay:', error);
      throw new Error(`Failed to get minimum delay: ${error.message}`);
    }
  }
} 