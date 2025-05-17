import { Service, IAgentRuntime, logger } from '@elizaos/core';
import { Contract, Wallet, JsonRpcProvider, ContractTransactionResponse } from 'ethers';
import { PolygonRpcService } from './PolygonRpcService.js';
import { getGasPriceEstimates } from './GasService.js';
import { CONTRACT_ADDRESSES } from '../config.js';
import { formatWei } from '../utils/formatters.js';

// Import ABIs
import ERC20ABI from '../contracts/ERC20ABI.json';
import RootChainManagerABI from '../contracts/RootChainManagerABI.json';

/**
 * Result of a bridge deposit operation
 */
export interface BridgeDepositResult {
  approvalTxHash?: string;
  depositTxHash: string;
  tokenAddress: string;
  amount: bigint;
  recipientAddress: string;
}

/**
 * Service for Polygon bridge operations (L1 <-> L2)
 */
export class PolygonBridgeService extends Service {
  static serviceType = 'polygonBridge';
  capabilityDescription = 'Provides bridging functionality between Ethereum (L1) and Polygon (L2)';

  private l1Provider: JsonRpcProvider | null = null;
  private l1Signer: Wallet | null = null;
  private rootChainManagerContract: Contract | null = null;
  private rpcService: PolygonRpcService | null = null;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  /**
   * Initializes the bridge service with required providers and contracts
   */
  private async initializeService(): Promise<void> {
    if (!this.runtime) {
      throw new Error('Runtime required for service initialization');
    }

    try {
      // Get RPC service first
      this.rpcService = this.runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
      if (!this.rpcService) {
        throw new Error('PolygonRpcService not available');
      }

      // Get L1 provider and create a signer
      const privateKey = this.runtime.getSetting('PRIVATE_KEY');
      if (!privateKey) {
        throw new Error('Private key not available');
      }

      this.l1Provider = this.rpcService.getEthersProvider('L1');
      this.l1Signer = new Wallet(privateKey, this.l1Provider);

      // Initialize the RootChainManager contract
      this.rootChainManagerContract = new Contract(
        CONTRACT_ADDRESSES.ROOT_CHAIN_MANAGER_ADDRESS_L1,
        RootChainManagerABI,
        this.l1Signer
      );

      logger.info('PolygonBridgeService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize PolygonBridgeService:', error);
      throw error;
    }
  }

  /**
   * Initializes an ERC20 contract instance with signer
   */
  private getERC20Contract(tokenAddress: string): Contract {
    if (!this.l1Signer) {
      throw new Error('L1 signer not initialized');
    }
    
    return new Contract(
      tokenAddress,
      ERC20ABI,
      this.l1Signer
    );
  }

  /**
   * Approves the RootChainManager contract to spend tokens
   */
  private async approveERC20(
    tokenAddress: string, 
    amount: bigint,
    gasPrice?: bigint
  ): Promise<string> {
    if (!this.l1Signer || !this.rootChainManagerContract) {
      throw new Error('Bridge service not properly initialized');
    }

    const tokenContract = this.getERC20Contract(tokenAddress);
    const signerAddress = this.l1Signer.address;
    
    // Check current allowance
    const currentAllowance = await tokenContract.allowance(
      signerAddress, 
      CONTRACT_ADDRESSES.ROOT_CHAIN_MANAGER_ADDRESS_L1
    );
    
    // Skip approval if already approved for sufficient amount
    if (currentAllowance >= amount) {
      logger.info(`Approval already exists for ${formatWei(amount)} tokens`);
      return "0x0000000000000000000000000000000000000000000000000000000000000000";
    }
    
    // Prepare transaction options with gas price if provided
    const options: any = {};
    if (gasPrice) {
      options.gasPrice = gasPrice;
    }
    
    // Execute the approve transaction
    logger.info(`Approving ${formatWei(amount)} tokens for RootChainManager contract...`);
    const tx = await tokenContract.approve(
      CONTRACT_ADDRESSES.ROOT_CHAIN_MANAGER_ADDRESS_L1,
      amount,
      options
    ) as ContractTransactionResponse;
    
    // Add defensive check for tx object
    if (!tx || typeof tx !== 'object') {
      throw new Error('Invalid transaction response from approve method');
    }
    
    // Add defensive check for tx.hash
    if (!tx.hash) {
      throw new Error('Transaction hash missing from approve response');
    }
    
    logger.info(`Approval transaction submitted: ${tx.hash}`);
    
    // Wait for the transaction to be confirmed
    const receipt = await tx.wait();
    
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Approval transaction failed: ${tx.hash}`);
    }
    
    logger.info(`Approval transaction confirmed: ${tx.hash}`);
    return tx.hash;
  }
  
  /**
   * Bridge ERC20 tokens from L1 (Ethereum) to L2 (Polygon)
   * 
   * @param tokenAddressL1 The address of the token on L1
   * @param amountWei The amount to bridge in wei
   * @param recipientAddressL2 Optional recipient address on L2 (defaults to sender's address)
   * @param options Optional configuration like timeout and gas price multiplier
   * @returns Result of the bridge deposit operation
   */
  async bridgeDeposit(
    tokenAddressL1: string,
    amountWei: bigint,
    recipientAddressL2?: string,
    options?: {
      /** Maximum time to wait for approval in milliseconds */
      approvalTimeoutMs?: number;
      /** Gas price multiplier for faster transactions (e.g., 1.2 = 20% higher) */
      gasPriceMultiplier?: number;
      /** Skip waiting for transaction confirmations (risky) */
      skipConfirmation?: boolean;
    }
  ): Promise<BridgeDepositResult> {
    // Default options
    const defaultOptions = {
      approvalTimeoutMs: 300000, // 5 minutes
      gasPriceMultiplier: 1.0,
      skipConfirmation: false
    };
    
    // Merge with provided options
    const { approvalTimeoutMs, gasPriceMultiplier, skipConfirmation } = {
      ...defaultOptions,
      ...options
    };
    
    if (!this.l1Signer || !this.rootChainManagerContract) {
      throw new Error('Bridge service not properly initialized');
    }
    
    // Validate parameters
    if (!tokenAddressL1 || !tokenAddressL1.startsWith('0x') || tokenAddressL1.length !== 42) {
      throw new Error('Invalid token address');
    }
    
    if (!amountWei || amountWei <= BigInt(0)) {
      throw new Error('Invalid amount');
    }
    
    // If recipient not provided, use the sender's address
    const recipient = recipientAddressL2 || this.l1Signer.address;
    
    // Validate recipient address
    if (!recipient || !recipient.startsWith('0x') || recipient.length !== 42) {
      throw new Error('Invalid recipient address');
    }
    
    // Get gas price estimates if multiplier is provided
    let gasPrice: bigint | undefined = undefined;
    if (gasPriceMultiplier !== 1.0) {
      try {
        const estimates = await getGasPriceEstimates();
        const baseFee = estimates.estimatedBaseFee;
        const priorityFee = estimates.fast.maxPriorityFeePerGas;
        
        // Calculate total gas price with multiplier
        if (baseFee && priorityFee) {
          const baseGasPrice = baseFee + priorityFee;
          gasPrice = BigInt(Math.floor(Number(baseGasPrice) * gasPriceMultiplier));
          logger.info(`Using custom gas price: ${gasPrice} wei (${gasPriceMultiplier}x multiplier)`);
        }
      } catch (error) {
        logger.warn('Failed to get gas price estimates, using default gas price', error);
      }
    }
    
    try {
      // Step 1: Approve the RootChainManager to spend tokens
      let approvalTxHash: string | undefined;
      
      try {
        // Set a timeout for the approval process
        const approvalPromise = this.approveERC20(tokenAddressL1, amountWei, gasPrice);
        
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Approval transaction timed out')), approvalTimeoutMs);
        });
        
        // Race the promises
        approvalTxHash = await Promise.race([approvalPromise, timeoutPromise]);
        
        // If the hash is the zero hash, it means no approval was needed
        if (approvalTxHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
          approvalTxHash = undefined;
        }
      } catch (error) {
        logger.error('Token approval failed:', error);
        throw new Error(`Token approval failed: ${error.message}`);
      }
      
      // Step 2: Encode the deposit data (amount as hex)
      // The deposit data should be a hex string of 32 bytes (64 hex chars + '0x' prefix)
      const depositData = '0x' + amountWei.toString(16).padStart(64, '0');
      
      // Step 3: Execute the deposit transaction
      logger.info(`Depositing ${formatWei(amountWei)} tokens to Polygon...`);
      
      // Prepare transaction options
      const depositOptions: any = {};
      if (gasPrice) {
        depositOptions.gasPrice = gasPrice;
      }
      
      // Execute the deposit transaction
      const depositTx = await this.rootChainManagerContract.depositFor(
        recipient,
        tokenAddressL1,
        depositData,
        depositOptions
      ) as ContractTransactionResponse;
      
      logger.info(`Deposit transaction submitted: ${depositTx.hash}`);
      
      // Wait for confirmation if not skipped
      if (!skipConfirmation) {
        try {
          const receipt = await depositTx.wait();
          if (!receipt || receipt.status !== 1) {
            throw new Error(`Deposit transaction failed: ${depositTx.hash}`);
          }
          logger.info(`Deposit transaction confirmed: ${depositTx.hash}`);
        } catch (error) {
          logger.error('Deposit transaction failed:', error);
          throw new Error(`Deposit transaction failed: ${error.message}`);
        }
      }
      
      // Return the result
      return {
        approvalTxHash,
        depositTxHash: depositTx.hash,
        tokenAddress: tokenAddressL1,
        amount: amountWei,
        recipientAddress: recipient
      };
    } catch (error) {
      logger.error('Bridge deposit failed:', error);
      throw error;
    }
  }

  static async start(runtime: IAgentRuntime): Promise<PolygonBridgeService> {
    logger.info(`Starting PolygonBridgeService...`);
    const service = new PolygonBridgeService(runtime);
    await service.initializeService();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping PolygonBridgeService...');
  }

  async stop(): Promise<void> {
    logger.info('PolygonBridgeService instance stopped.');
    this.l1Provider = null;
    this.l1Signer = null;
    this.rootChainManagerContract = null;
    this.rpcService = null;
  }
} 