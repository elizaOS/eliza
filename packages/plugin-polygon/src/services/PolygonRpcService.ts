import { Service, type IAgentRuntime, logger } from '@elizaos/core';
import {
  ethers,
  JsonRpcProvider,
  type Provider as EthersProvider,
  type Signer,
  Wallet, // Import Wallet for signer creation
  type TransactionResponse,
  type TransactionReceipt,
  type Block,
  Contract,
  type BigNumberish,
  ZeroAddress,
  type TransactionRequest,
  MaxUint256, // Import MaxUint256 for approval checks
} from 'ethers'; // Assuming ethers v6+

// Import JSON ABIs
import StakeManagerABI from '../contracts/StakeManagerABI.json' assert { type: 'json' };
import ValidatorShareABI from '../contracts/ValidatorShareABI.json' assert { type: 'json' };
import RootChainManagerABI from '../contracts/RootChainManagerABI.json' assert { type: 'json' };
import Erc20ABI from '../contracts/ERC20ABI.json' assert { type: 'json' };
import CheckpointManagerABI from '../contracts/CheckpointManagerABI.json' assert { type: 'json' };

// Re-import GasService components
import { getGasPriceEstimates, type GasPriceEstimates } from './GasService.js';

export type NetworkType = 'L1' | 'L2';

// --- Staking Contract Addresses (Ethereum Mainnet) ---
const STAKE_MANAGER_ADDRESS_L1 = '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908';
const ROOT_CHAIN_MANAGER_ADDRESS_L1 = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77'; // Added RootChainManager Address

// --- Type Definitions for Staking Info ---

// Enum mapping based on StakeManager contract inspection (adjust if needed)
export enum ValidatorStatus { // Renamed for clarity
  Inactive = 0,
  Active = 1,
  Unbonding = 2,
  Jailed = 3,
}

export interface ValidatorInfo {
  status: ValidatorStatus;
  totalStake: bigint; // Combined self-stake + delegated amount
  commissionRate: number; // Percentage (e.g., 0.1 for 10%)
  signerAddress: string;
  activationEpoch: bigint;
  deactivationEpoch: bigint;
  jailEndEpoch: bigint;
  contractAddress: string; // Address of the ValidatorShare contract
  lastRewardUpdateEpoch: bigint;
  // Add other relevant fields from the struct if needed
}

export interface DelegatorInfo {
  delegatedAmount: bigint;
  pendingRewards: bigint;
}

export class PolygonRpcService extends Service {
  static serviceType = 'polygonRpc';
  capabilityDescription =
    'Provides access to Ethereum (L1) and Polygon (L2) JSON-RPC nodes and L1 staking operations.';

  runtime: IAgentRuntime;
  private l1Provider: EthersProvider | null = null;
  private l2Provider: EthersProvider | null = null;
  private l1Signer: Signer | null = null; // Added L1 Signer
  private stakeManagerContractL1: Contract | null = null; // Added for L1 StakeManager
  private rootChainManagerContractL1: Contract | null = null; // Added RootChainManager instance

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  private async initializeProviders(): Promise<void> {
    if (this.l1Provider && this.l2Provider && this.rootChainManagerContractL1) {
      return;
    }
    if (!this.runtime) {
      throw new Error('Runtime required');
    }

    const l1RpcUrl = this.runtime.getSetting('ETHEREUM_RPC_URL');
    const l2RpcUrl = this.runtime.getSetting('POLYGON_RPC_URL');
    const privateKey = this.runtime.getSetting('PRIVATE_KEY'); // Get private key

    if (!l1RpcUrl || !l2RpcUrl) {
      throw new Error('Missing L1/L2 RPC URLs');
    }
    if (!privateKey) {
      throw new Error('Missing PRIVATE_KEY for signer initialization');
    }

    try {
      this.l1Provider = new JsonRpcProvider(l1RpcUrl);
      this.l2Provider = new JsonRpcProvider(l2RpcUrl);
      // Initialize L1 Signer
      this.l1Signer = new Wallet(privateKey, this.l1Provider);
      logger.info('PolygonRpcService initialized L1/L2 providers and L1 signer.');

      // Initialize StakeManager contract instance (using L1 Provider for reads)
      this.stakeManagerContractL1 = new Contract(
        STAKE_MANAGER_ADDRESS_L1,
        StakeManagerABI,
        this.l1Provider
      );
      // Test connection by calling a valid function (e.g., epoch instead of validatorThreshold)
      await this.stakeManagerContractL1.epoch(); // Test connection
      logger.info('StakeManager L1 contract instance created and connection verified.');

      this.rootChainManagerContractL1 = new Contract(
        ROOT_CHAIN_MANAGER_ADDRESS_L1,
        RootChainManagerABI,
        this.l1Signer // Use signer for sending transactions
      );
      // Optional: Test RootChainManager connectivity (e.g., read chainId)
      // const chainId = await this.rootChainManagerContractL1.chainID();
      // logger.info(`RootChainManager L1 contract connection verified (Chain ID: ${chainId}).`);
      logger.info('RootChainManager L1 contract instance created.');

      logger.debug('RootChainManager contract details:', {
        address: ROOT_CHAIN_MANAGER_ADDRESS_L1,
        methods: this.rootChainManagerContractL1.interface.fragments
          .map((f: { name?: string }) => (typeof f === 'object' && f.name ? f.name : 'unnamed'))
          .join(', '),
      });
    } catch (error) {
      logger.error('Failed during PolygonRpcService initialization:', error);
      this.l1Provider = null;
      this.l2Provider = null;
      this.l1Signer = null;
      this.stakeManagerContractL1 = null;
      this.rootChainManagerContractL1 = null;
      throw new Error('Failed to initialize PolygonRpcService components');
    }
  }

  static async start(runtime: IAgentRuntime): Promise<PolygonRpcService> {
    logger.info('Starting PolygonRpcService...');
    const service = new PolygonRpcService(runtime);
    await service.initializeProviders();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    logger.info('Stopping PolygonRpcService...');
    const service = runtime.getService<PolygonRpcService>(PolygonRpcService.serviceType);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    logger.info('PolygonRpcService instance stopped.');
    this.l1Provider = null;
    this.l2Provider = null;
    this.l1Signer = null; // Clear signer
    this.stakeManagerContractL1 = null; // Clear contract instance
    this.rootChainManagerContractL1 = null; // Clear RCM instance
  }

  private getProvider(network: NetworkType): EthersProvider {
    const provider = network === 'L1' ? this.l1Provider : this.l2Provider;
    if (!provider) {
      throw new Error(`Provider ${network} not initialized.`);
    }
    return provider;
  }

  // Get L1 Signer (ensure initialized)
  private getL1Signer(): Signer {
    if (!this.l1Signer) {
      throw new Error('L1 Signer is not initialized.');
    }
    return this.l1Signer;
  }

  // Helper to get initialized StakeManager contract
  private getStakeManagerContract(): Contract {
    if (!this.stakeManagerContractL1) {
      throw new Error('StakeManager L1 contract is not initialized.');
    }
    return this.stakeManagerContractL1;
  }

  // Helper to get initialized RootChainManager contract
  private getRootChainManagerContract(): Contract {
    if (!this.rootChainManagerContractL1) {
      throw new Error('RootChainManager L1 contract is not initialized.');
    }
    return this.rootChainManagerContractL1;
  }

  // --- Helper: Get Signer-Aware ValidatorShare Contract ---
  private async _getValidatorShareContract(validatorId: number): Promise<Contract> {
    const stakeManager = this.getStakeManagerContract();
    const signer = this.getL1Signer(); // Use L1 Signer

    logger.debug(`Fetching ValidatorShare contract address for validator ${validatorId}...`);
    const validatorShareAddress = await stakeManager.getValidatorContract(validatorId);

    if (!validatorShareAddress || validatorShareAddress === ZeroAddress) {
      logger.error(
        `ValidatorShare contract address not found or zero for validator ID ${validatorId}.`
      );
      throw new Error(`Validator ${validatorId} does not have a valid ValidatorShare contract.`);
    }
    logger.debug(`Found ValidatorShare address: ${validatorShareAddress}`);

    // Return instance connected to the L1 Signer
    const validatorShareContract = new Contract(validatorShareAddress, ValidatorShareABI, signer);

    // Attempt to verify contract interface by checking one of the required methods
    try {
      if (!validatorShareContract.interface.getFunction('buyVoucher(uint256,uint256)')) {
        logger.warn(
          `ValidatorShare contract at ${validatorShareAddress} may not have expected interface - buyVoucher(uint256,uint256) not found.`
        );
      }
    } catch (error: unknown) {
      // Log but don't throw - individual method calls will validate specific functions
      logger.warn(
        `Could not verify ValidatorShare contract interface: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return validatorShareContract;
  }

  // --- Core EVM Wrappers --- (remain the same)
  async getBlockNumber(network: NetworkType): Promise<number> {
    try {
      const provider = this.getProvider(network);
      return await provider.getBlockNumber();
    } catch (error) {
      logger.error(`Error in getBlockNumber (${network}):`, error);
      throw error; // Re-throw for upstream handling
    }
  }

  async getBalance(address: string, network: NetworkType): Promise<bigint> {
    try {
      const provider = this.getProvider(network);
      return await provider.getBalance(address);
    } catch (error) {
      logger.error(`Error in getBalance (${network}) for ${address}:`, error);
      throw error;
    }
  }

  async getTransaction(txHash: string, network: NetworkType): Promise<TransactionResponse | null> {
    try {
      const provider = this.getProvider(network);
      return await provider.getTransaction(txHash);
    } catch (error) {
      logger.error(`Error in getTransaction (${network}) for ${txHash}:`, error);
      throw error;
    }
  }

  async getTransactionReceipt(
    txHash: string,
    network: NetworkType
  ): Promise<TransactionReceipt | null> {
    try {
      const provider = this.getProvider(network);
      return await provider.getTransactionReceipt(txHash);
    } catch (error) {
      logger.error(`Error in getTransactionReceipt (${network}) for ${txHash}:`, error);
      throw error;
    }
  }

  async getBlock(blockIdentifier: string | number, network: NetworkType): Promise<Block | null> {
    try {
      const provider = this.getProvider(network);
      return await provider.getBlock(blockIdentifier);
    } catch (error) {
      logger.error(`Error in getBlock (${network}) for ${blockIdentifier}:`, error);
      throw error;
    }
  }

  async call(transaction: TransactionRequest, network: NetworkType): Promise<string> {
    try {
      const provider = this.getProvider(network);
      // Ensure blockTag is handled if needed, defaulting to latest
      return await provider.call(transaction);
    } catch (error) {
      logger.error(`Error in call (${network}):`, error);
      throw error;
    }
  }

  async sendRawTransaction(signedTx: string, network: NetworkType): Promise<TransactionResponse> {
    try {
      const provider = this.getProvider(network);
      // ethers v6 returns a TransactionResponse directly
      return await provider.broadcastTransaction(signedTx);
    } catch (error) {
      logger.error(`Error in sendRawTransaction (${network}):`, error);
      throw error;
    }
  }

  // --- Polygon L2 Specific Read Functions --- (Existing methods remain unchanged)
  async getCurrentBlockNumber(): Promise<number> {
    logger.debug('Getting current L2 block number...');
    return this.getBlockNumber('L2');
  }

  async getBlockDetails(identifier: string | number): Promise<Block | null> {
    logger.debug(`Getting L2 block details for: ${identifier}`);
    return this.getBlock(identifier, 'L2');
  }

  /**
   * Gets transaction details and receipt for a given hash on Polygon (L2).
   * @param txHash Transaction hash.
   * @returns An object containing the transaction response and receipt, or null if not found.
   */
  async getTransactionDetails(txHash: string): Promise<{
    transaction: TransactionResponse | null;
    receipt: TransactionReceipt | null;
  } | null> {
    logger.debug(`Getting L2 transaction details for: ${txHash}`);
    try {
      const [transaction, receipt] = await Promise.all([
        this.getTransaction(txHash, 'L2'),
        this.getTransactionReceipt(txHash, 'L2'),
      ]);

      if (!transaction && !receipt) {
        return null; // Neither found
      }
      return { transaction, receipt };
    } catch (error) {
      // Errors are logged in underlying wrappers, re-throw if needed
      logger.error(`Failed to get full transaction details for ${txHash} on L2.`);
      throw error;
    }
  }

  async getNativeBalance(address: string): Promise<bigint> {
    logger.debug(`Getting native L2 balance for: ${address}`);
    return this.getBalance(address, 'L2');
  }

  async getErc20Balance(tokenAddress: string, accountAddress: string): Promise<bigint> {
    logger.debug(
      `Getting ERC20 balance for token ${tokenAddress} on account ${accountAddress} on L2...`
    );
    try {
      // Use getProvider to ensure service is initialized
      const l2Provider = this.getProvider('L2');
      const contract = new Contract(tokenAddress, Erc20ABI, l2Provider);
      const balance: BigNumberish = await contract.balanceOf(accountAddress);
      // Ensure balance is returned as bigint
      return BigInt(balance.toString());
    } catch (error) {
      logger.error(`Error fetching ERC20 balance for ${tokenAddress} / ${accountAddress}:`, error);
      // Handle specific errors like invalid address or contract not found if possible
      throw error;
    }
  }

  // --- Staking Read Operations (L1) ---

  /**
   * Fetches detailed information about a specific validator from the L1 StakeManager.
   * @param validatorId The ID of the validator.
   * @returns A promise resolving to ValidatorInfo or null if not found.
   */
  async getValidatorInfo(validatorId: number): Promise<ValidatorInfo | null> {
    logger.debug(`Getting L1 validator info for ID: ${validatorId}`);
    try {
      const stakeManager = this.getStakeManagerContract();

      // We need to use multiple contract calls to build the validator info
      // First, check if the validator exists by trying to get their stake
      try {
        // Check if we can get the stake - this will throw if validator doesn't exist
        await stakeManager.validatorStake(validatorId);
      } catch (e: unknown) {
        logger.warn(
          `Validator ID ${validatorId} not found or inactive. ${e instanceof Error ? e.message : String(e)}`
        );
        return null;
      }

      // Gather basic information using separate calls
      const [
        stake,
        validatorShareAddress,
        // Add other relevant calls as needed
      ] = await Promise.all([
        stakeManager.validatorStake(validatorId),
        stakeManager.getValidatorContract(validatorId),
        // Add other contract methods here
      ]);

      // Calculate total stake (validator's own stake + delegated amount)
      const validatorStake = BigInt(stake.toString());
      let totalStake = validatorStake;
      try {
        const delegated = await stakeManager.delegatedAmount(validatorId);
        totalStake = totalStake + BigInt(delegated.toString());
      } catch (e: unknown) {
        logger.warn(
          `Could not get delegated amount for validator ${validatorId}: ${e instanceof Error ? e.message : String(e)}`
        );
      }

      // Determine status - since we don't have direct status info, assume Active
      // if they have a contract address and non-zero stake
      let status = ValidatorStatus.Inactive;
      if (validatorShareAddress && validatorShareAddress !== ZeroAddress && totalStake > 0n) {
        status = ValidatorStatus.Active;
      }

      // Try to get commission rate from ValidatorShare contract
      let commissionRate = 0;
      const lastRewardUpdateEpoch = 0n;
      let signerAddress = '';

      if (validatorShareAddress && validatorShareAddress !== ZeroAddress) {
        try {
          const validatorShareContract = new Contract(
            validatorShareAddress,
            ValidatorShareABI,
            this.getProvider('L1')
          );

          // Try to get commission rate from validator share contract
          if (typeof validatorShareContract.commissionRate === 'function') {
            try {
              const commissionRateResult = await validatorShareContract.commissionRate();
              commissionRate = Number(commissionRateResult) / 10000; // Convert from basis points (100 = 1%)
            } catch (e: unknown) {
              logger.debug(
                `Commission rate not available for validator ${validatorId}: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }

          // Try to get validator address/signer
          if (typeof validatorShareContract.owner === 'function') {
            try {
              signerAddress = await validatorShareContract.owner();
            } catch (e: unknown) {
              logger.debug(
                `Owner address not available for validator ${validatorId}: ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        } catch (e: unknown) {
          logger.warn(
            `Error interacting with ValidatorShare contract: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      // Build the validator info object with the data we were able to retrieve
      const info: ValidatorInfo = {
        status: status,
        totalStake: totalStake,
        commissionRate: commissionRate,
        signerAddress: signerAddress || ZeroAddress,
        activationEpoch: 0n, // We don't have this info directly
        deactivationEpoch: 0n, // We don't have this info directly
        jailEndEpoch: 0n, // We don't have this info directly
        contractAddress: validatorShareAddress || ZeroAddress,
        lastRewardUpdateEpoch: lastRewardUpdateEpoch,
      };

      return info;
    } catch (error) {
      logger.error(
        `Error fetching validator info for ID ${validatorId} from L1 StakeManager:`,
        error
      );
      // Handle specific errors (e.g., contract revert) if possible
      throw error; // Re-throw for upstream handling
    }
  }

  /**
   * Fetches staking details for a specific delegator address related to a specific validator.
   * @param validatorId The ID of the validator.
   * @param delegatorAddress The address of the delegator.
   * @returns A promise resolving to DelegatorInfo or null if validator/delegator relationship not found.
   */
  async getDelegatorInfo(
    validatorId: number,
    delegatorAddress: string
  ): Promise<DelegatorInfo | null> {
    logger.debug(
      `Getting L1 delegator info for validator ${validatorId} and delegator ${delegatorAddress}`
    );
    try {
      const stakeManager = this.getStakeManagerContract();
      const l1Provider = this.getProvider('L1');

      // Step 1: Get ValidatorShare contract address
      const validatorShareAddress = await stakeManager.getValidatorContract(validatorId);

      if (!validatorShareAddress || validatorShareAddress === ZeroAddress) {
        logger.warn(`ValidatorShare contract address not found for validator ID ${validatorId}.`);
        return null;
      }

      // Step 2: Instantiate ValidatorShare contract
      const validatorShareContract = new Contract(
        validatorShareAddress,
        ValidatorShareABI,
        l1Provider
      );

      // Step 3 & 4: Get delegated amount and pending rewards
      // Verify exact function names from ABI ('getTotalStake', 'getLiquidRewards' or 'pendingRewards')
      const [delegatedAmountResult, pendingRewardsResult] = await Promise.all([
        validatorShareContract.getTotalStake(delegatorAddress), // Verify name
        validatorShareContract.getLiquidRewards(delegatorAddress), // Verify name (often 'getLiquidRewards')
      ]);

      const info: DelegatorInfo = {
        delegatedAmount: BigInt(delegatedAmountResult.toString()),
        pendingRewards: BigInt(pendingRewardsResult.toString()),
      };

      // Optional: Check if delegatedAmount is zero to consider if delegator exists for this validator
      // if (info.delegatedAmount === 0n) { return null; }

      return info;
    } catch (error) {
      logger.error(
        `Error fetching delegator info for V:${validatorId}/D:${delegatorAddress} from L1:`,
        error
      );
      // Handle specific errors (e.g., contract revert if delegator never staked)
      // Often reverts happen if delegator has no stake - might return null instead of throwing
      if (
        error instanceof Error &&
        (error.message.includes('delegator never staked') ||
          ('code' in error && (error as any).code === 'CALL_EXCEPTION'))
      ) {
        // Example error check
        logger.warn(
          `Delegator ${delegatorAddress} likely has no stake with validator ${validatorId}.`
        );
        return null;
      }
      throw error; // Re-throw for upstream handling
    }
  }

  // --- L1 Staking Write Operations ---

  /**
   * Delegates MATIC to a validator on L1.
   * @param validatorId The ID of the validator.
   * @param amountWei Amount of MATIC/POL to delegate in Wei.
   * @returns Transaction hash of the delegation transaction.
   */
  async delegate(validatorId: number, amountWei: bigint): Promise<string> {
    logger.info(
      `Initiating delegation of ${ethers.formatEther(amountWei)} MATIC to validator ${validatorId} on L1...`
    );
    if (amountWei <= 0n) {
      throw new Error('Delegation amount must be greater than zero.');
    }
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');

    try {
      // Get the ValidatorShare contract for this validator
      const validatorShareContract = await this._getValidatorShareContract(validatorId);

      // Validate that the required function exists
      if (!validatorShareContract.interface.getFunction('buyVoucher(uint256,uint256)')) {
        throw new Error('ValidatorShare contract does not expose buyVoucher(uint256,uint256)');
      }

      // Get MATIC token contract and approve spending
      const maticToken = this.getMaticToken();
      const signerAddress = await signer.getAddress();

      // Check allowance and approve if needed
      logger.debug(
        `Checking MATIC token allowance for validator share contract ${validatorShareContract.target}...`
      );
      const allowance = await maticToken.allowance(signerAddress, validatorShareContract.target);

      if (allowance < amountWei) {
        logger.info(`Approving ${ethers.formatEther(amountWei)} MATIC for delegation...`);
        const approveTx = await maticToken.approve(validatorShareContract.target, amountWei);
        logger.info(
          `MATIC approval transaction sent: ${approveTx.hash}. Waiting for confirmation...`
        );
        await approveTx.wait(1); // Wait for 1 confirmation
        logger.info('MATIC approval confirmed. Proceeding with delegation.');
      } else {
        logger.info(
          `Existing allowance of ${ethers.formatEther(allowance)} MATIC is sufficient. Skipping approval.`
        );
      }

      // Prepare transaction data for buyVoucher WITHOUT fee details
      // The buyVoucher function takes (amount, minSharesToMint)
      // For minSharesToMint, we'll use 0 to accept whatever the contract calculates
      const txData = await validatorShareContract.buyVoucher.populateTransaction(amountWei, 0);

      // Estimate gas BEFORE adding fee details
      // Important: DO NOT include value in gas estimation - this is an ERC20 transfer
      const gasLimit = await signer.estimateGas({
        ...txData,
      });
      const gasLimitBuffered = (gasLimit * 120n) / 100n; // Add 20% buffer

      // AFTER estimating gas, get fee details
      const { maxFeePerGas, maxPriorityFeePerGas } = await this._getL1FeeDetails();

      // ------------------------------------------------------------------
      // Dynamic balance guard – replaces any hard-coded "need 0.1 ETH" logic
      // ------------------------------------------------------------------
      const walletBalance = await l1Provider.getBalance(signerAddress);

      // Calculate estimated fee plus safety margin
      const estFee = gasLimitBuffered * maxFeePerGas; // wei
      const safety = ethers.parseUnits('0.002', 'ether'); // 0.002 ETH ≈ 10 %

      if (walletBalance < estFee + safety) {
        throw new Error(
          `Insufficient ETH: you have ${ethers.formatEther(walletBalance)} but need about ${ethers.formatEther(estFee + safety)} for gas.`
        );
      }

      // Construct Full Transaction
      const tx: TransactionRequest = {
        ...txData,
        // Do not set value - this is an ERC20 transfer, not ETH
        gasLimit: gasLimitBuffered,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId, // Ensure correct chain ID
      };

      // Get current nonce before signing
      const nonce = await signer.getNonce();
      tx.nonce = nonce;

      // Add debugging info
      logger.debug('Transaction details:', {
        to: tx.to,
        gasLimit: tx.gasLimit?.toString(),
        maxFeePerGas: tx.maxFeePerGas?.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
        value: tx.value?.toString() || 'undefined (correct - no ETH value should be sent)',
      });

      // Sign Transaction
      logger.debug('Signing delegation transaction...');
      const signedTx = await signer.signTransaction(tx);

      // Broadcast Transaction
      logger.info(`Broadcasting L1 delegation transaction for validator ${validatorId}...`);
      const txResponse = await this.sendRawTransaction(signedTx, 'L1');
      logger.info(`Delegation transaction sent: ${txResponse.hash}`);

      // Return Hash
      return txResponse.hash;
    } catch (error: unknown) {
      logger.error(`Delegation to validator ${validatorId} failed:`, error);
      // Add more specific error handling (insufficient funds, etc.)
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Delegation failed: ${errorMessage}`);
    }
  }

  /**
   * Gets the MATIC token contract on Ethereum L1
   * @returns The MATIC token contract connected to the signer
   */
  private getMaticToken(): Contract {
    // Ethereum Mainnet MATIC token address
    const MATIC_TOKEN_ADDRESS = '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0';
    const signer = this.getL1Signer();

    return new Contract(MATIC_TOKEN_ADDRESS, Erc20ABI, signer);
  }

  /**
   * Initiates undelegation (unbonding) of shares from a validator on L1.
   * @param validatorId The ID of the validator.
   * @param sharesAmountWei Amount of Validator Shares to undelegate (in Wei).
   * @returns Transaction hash of the undelegation transaction.
   */
  async undelegate(
    validatorId: number,
    sharesAmountWei: bigint // This is the precisely calculated shares amount
  ): Promise<string> {
    logger.info(
      `Initiating undelegation of approximately ${sharesAmountWei} shares from validator ${validatorId} on L1...`
    );
    if (sharesAmountWei <= 0n) {
      throw new Error('Undelegation shares amount must be greater than zero.');
    }
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');
    const contract = await this._getValidatorShareContract(validatorId);

    try {
      // Validate that the required function exists
      if (!contract.interface.getFunction('sellVoucher(uint256,uint256)')) {
        throw new Error('ValidatorShare contract does not expose sellVoucher(uint256,uint256)');
      }

      // Add a slippage buffer to the sharesAmountWei to get maxSharesToBurn
      // Buffer: 0.1% of shares (or minimum +1 share for very small amounts)
      const buffer = sharesAmountWei / 1000n; // 0.1%
      const maxSharesToBurn = sharesAmountWei + buffer + 1n;

      logger.debug(
        `Calculated shares: ${sharesAmountWei}, Max shares to burn (with buffer): ${maxSharesToBurn}`
      );

      const txData = await contract['sellVoucher(uint256,uint256)'].populateTransaction(
        sharesAmountWei,
        maxSharesToBurn
      ); // Use sharesAmountWei for amount, maxSharesToBurn for limit

      const gasLimit = await signer.estimateGas({ ...txData });
      const gasLimitBuffered = (gasLimit * 120n) / 100n;

      // 3. Get Gas Estimates AFTER estimating gas
      const { maxFeePerGas, maxPriorityFeePerGas } = await this._getL1FeeDetails();

      // 4. Construct Full Transaction
      const tx: TransactionRequest = {
        ...txData,
        // No value field for undelegate
        gasLimit: gasLimitBuffered,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId,
      };

      // Get current nonce before signing
      const nonce = await signer.getNonce();
      tx.nonce = nonce;

      // 5. Sign Transaction
      logger.debug('Signing undelegation transaction...', tx);
      const signedTx = await signer.signTransaction(tx);

      // 6. Broadcast Transaction
      logger.info(`Broadcasting L1 undelegation transaction for validator ${validatorId}...`);
      const txResponse = await this.sendRawTransaction(signedTx, 'L1');
      logger.info(`Undelegation transaction sent: ${txResponse.hash}`);

      // 7. Return Hash
      return txResponse.hash;
    } catch (error: unknown) {
      logger.error(`Undelegation from validator ${validatorId} failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Undelegation failed: ${errorMessage}`);
    }
  }

  /**
   * Converts MATIC amount to validator shares using the exchange rate.
   * @param validatorId The ID of the validator.
   * @param maticAmountWei The amount of MATIC in Wei to convert.
   * @returns The equivalent amount in validator shares.
   */
  async convertMaticToShares(validatorId: number, maticAmountWei: bigint): Promise<bigint> {
    logger.debug(
      `Converting ${maticAmountWei} Wei MATIC to shares for validator ${validatorId}...`
    );

    if (maticAmountWei <= 0n) {
      throw new Error('MATIC amount must be greater than zero.');
    }

    try {
      const validatorShareContract = await this._getValidatorShareContract(validatorId);

      // Validate that the required function exists
      if (!validatorShareContract.interface.getFunction('exchangeRate()')) {
        throw new Error('ValidatorShare contract does not expose exchangeRate()');
      }

      // Get the current exchange rate from the ValidatorShare contract
      const exchangeRate = await validatorShareContract.exchangeRate();

      if (exchangeRate <= 0n) {
        throw new Error('Invalid exchange rate received from ValidatorShare contract');
      }

      // Determine the correct precision based on validator ID
      // Validator IDs < 8 use a precision of 100, others use 10^29 (common for non-foundation)
      const validatorIdBigInt = BigInt(validatorId);
      const precision = validatorIdBigInt < 8n ? 100n : 10n ** 29n;

      // Calculate shares: shares = (maticAmountWei * precision) / exchangeRateFromContract
      const sharesAmount = (maticAmountWei * precision) / exchangeRate;

      logger.debug(
        `Validator ID: ${validatorId}, Precision: ${precision}, Exchange rate: ${exchangeRate}, Calculated ${maticAmountWei} Wei MATIC to ${sharesAmount} shares`
      );

      return sharesAmount;
    } catch (error: unknown) {
      logger.error(`Failed to convert MATIC to shares for validator ${validatorId}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`MATIC to shares conversion failed: ${errorMessage}`);
    }
  }

  /**
   * Withdraws pending rewards from a specific validator on L1.
   * @param validatorId The ID of the validator.
   * @returns Transaction hash of the reward withdrawal transaction.
   */
  async withdrawRewards(validatorId: number): Promise<string> {
    logger.info(`Initiating reward withdrawal from validator ${validatorId} on L1...`);
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');
    const contract = await this._getValidatorShareContract(validatorId);

    try {
      // Validate that the required function exists
      if (!contract.interface.getFunction('withdrawRewards()')) {
        throw new Error('ValidatorShare contract does not expose withdrawRewards()');
      }

      // 1. Prepare Transaction Data (Verify function name: withdrawRewards)
      const txData = await contract.withdrawRewards.populateTransaction();

      // 2. Estimate Gas Limit BEFORE fee details
      const gasLimit = await signer.estimateGas({ ...txData });
      const gasLimitBuffered = (gasLimit * 120n) / 100n;

      // 3. Get Gas Estimates AFTER estimating gas
      const { maxFeePerGas, maxPriorityFeePerGas } = await this._getL1FeeDetails();

      // 4. Construct Full Transaction
      const tx: TransactionRequest = {
        ...txData,
        // No value field for withdraw
        gasLimit: gasLimitBuffered,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId,
      };

      // Get current nonce before signing
      const nonce = await signer.getNonce();
      tx.nonce = nonce;

      // 5. Sign Transaction
      logger.debug('Signing reward withdrawal transaction...', tx);
      const signedTx = await signer.signTransaction(tx);

      // 6. Broadcast Transaction
      logger.info(`Broadcasting L1 reward withdrawal transaction for validator ${validatorId}...`);
      const txResponse = await this.sendRawTransaction(signedTx, 'L1');
      logger.info(`Reward withdrawal transaction sent: ${txResponse.hash}`);

      // 7. Return Hash
      return txResponse.hash;
    } catch (error: unknown) {
      logger.error(`Reward withdrawal from validator ${validatorId} failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Reward withdrawal failed: ${errorMessage}`);
    }
  }

  /**
   * Convenience method to withdraw rewards and immediately restake them to the same validator.
   * @param validatorId The ID of the validator.
   * @returns Transaction hash of the *delegation* transaction, or null if no rewards to restake.
   */
  async restakeRewards(validatorId: number): Promise<string | null> {
    logger.info(`Initiating restake for validator ${validatorId} on L1...`);
    const signer = this.getL1Signer();
    const delegatorAddress = await signer.getAddress();
    const l1Provider = this.getProvider('L1');
    const validatorShareContract = await this._getValidatorShareContract(validatorId);

    try {
      // Validate that the required functions exist
      if (!validatorShareContract.interface.getFunction('getLiquidRewards(address)')) {
        throw new Error('ValidatorShare contract does not expose getLiquidRewards(address)');
      }
      if (!validatorShareContract.interface.getFunction('withdrawRewards()')) {
        throw new Error('ValidatorShare contract does not expose withdrawRewards()');
      }

      // 1. Get pending rewards *before* withdrawing
      const delegatorInfo = await this.getDelegatorInfo(validatorId, delegatorAddress);
      const rewardsToRestake = delegatorInfo?.pendingRewards;

      if (!rewardsToRestake || rewardsToRestake <= 0n) {
        logger.warn(
          `No pending rewards found for ${delegatorAddress} on validator ${validatorId}. Nothing to restake.`
        );
        return null;
      }
      logger.info(`Found ${ethers.formatEther(rewardsToRestake)} MATIC rewards to restake.`);

      // 2. Withdraw Rewards
      const withdrawTxHash = await this.withdrawRewards(validatorId);
      logger.info(`Withdrawal tx sent (${withdrawTxHash}). Waiting for confirmation...`);

      // 3. Wait for Confirmation (Important!)
      const receipt = await l1Provider.waitForTransaction(withdrawTxHash, 1, 120000); // Wait 1 conf, timeout 2min
      if (!receipt || receipt.status !== 1) {
        logger.error(
          `Withdrawal transaction (${withdrawTxHash}) failed or timed out. Status: ${receipt?.status}`
        );
        throw new Error(`Reward withdrawal transaction failed (Hash: ${withdrawTxHash})`);
      }
      logger.info('Withdrawal transaction confirmed.');

      // 4. Delegate the withdrawn amount (which equals the previously fetched pendingRewards)
      logger.info(
        `Proceeding to delegate ${ethers.formatEther(rewardsToRestake)} MATIC rewards...`
      );
      const delegateTxHash = await this.delegate(validatorId, rewardsToRestake);

      return delegateTxHash; // Return the hash of the second (delegate) transaction
    } catch (error: unknown) {
      logger.error(`Restake operation for validator ${validatorId} failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Restake failed: ${errorMessage}`);
    }
  }

  // --- L1 -> L2 Bridge Deposit ---

  /**
   * Bridges an ERC20 token (including POL) from Ethereum L1 to Polygon L2.
   * Handles approval if necessary.
   * @param tokenAddressL1 Address of the ERC20 token contract on L1.
   * @param amountWei Amount of the token to bridge in Wei.
   * @param recipientAddressL2 Optional address to receive tokens on L2, defaults to sender.
   * @returns Transaction hash of the final deposit transaction.
   */
  async bridgeDeposit(
    tokenAddressL1: string,
    amountWei: bigint,
    recipientAddressL2?: string
  ): Promise<string> {
    logger.info(
      `Initiating L1->L2 bridge deposit of ${ethers.formatUnits(amountWei)} units for token ${tokenAddressL1}...`
    );
    if (amountWei <= 0n) {
      throw new Error('Bridge deposit amount must be greater than zero.');
    }
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');
    const rootChainManager = this.getRootChainManagerContract();
    const userAddress = recipientAddressL2 || (await signer.getAddress()); // Default to sender if no recipient

    try {
      // 1. Approve RootChainManager to spend the token
      // This helper handles checking allowance and sending tx only if needed
      await this._approveErc20IfNeeded(tokenAddressL1, amountWei, ROOT_CHAIN_MANAGER_ADDRESS_L1);
      // Approval (if sent) is confirmed within the helper

      // 2. Prepare and send the depositFor transaction
      const txDepositData = await rootChainManager.depositFor.populateTransaction(
        userAddress,
        tokenAddressL1,
        amountWei
      );

      const { maxFeePerGas, maxPriorityFeePerGas } = await this._getL1FeeDetails();

      const gasLimitDeposit = await signer.estimateGas({
        ...txDepositData,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId,
      });

      // 3. Construct Full Transaction
      const tx: TransactionRequest = {
        ...txDepositData,
        gasLimit: gasLimitDeposit,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId,
      };

      // 4. Sign Transaction
      logger.debug('Signing depositFor transaction...', tx);
      const signedTx = await signer.signTransaction(tx);

      // 5. Broadcast Transaction
      logger.info(`Broadcasting L1 depositFor transaction for token ${tokenAddressL1}...`);
      const txResponse = await this.sendRawTransaction(signedTx, 'L1');
      logger.info(`Bridge deposit transaction sent: ${txResponse.hash}`);

      // 6. Return Hash of the deposit transaction
      return txResponse.hash;
    } catch (error: unknown) {
      logger.error(`Bridge deposit for token ${tokenAddressL1} failed:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Bridge deposit failed: ${errorMessage}`);
    }
  }

  // --- Helper: Approve ERC20 spending if needed ---
  private async _approveErc20IfNeeded(
    tokenAddressL1: string,
    amountWei: bigint,
    spenderAddress: string
  ): Promise<string | null> {
    // Returns approve tx hash if sent, null otherwise
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');
    const ownerAddress = await signer.getAddress();
    const tokenContract = new Contract(tokenAddressL1, Erc20ABI, signer);

    logger.debug(
      `Checking allowance for ${ownerAddress} to spend ${tokenAddressL1} via ${spenderAddress}`
    );
    const currentAllowance: bigint = BigInt(
      (await tokenContract.allowance(ownerAddress, spenderAddress)).toString()
    );

    if (currentAllowance >= amountWei) {
      logger.info(
        `Sufficient allowance (${ethers.formatUnits(currentAllowance)} tokens) already exists for ${tokenAddressL1}. Skipping approval.`
      );
      return null; // No approval needed
    }

    if (currentAllowance > 0n) {
      // Reset allowance to 0 before setting new allowance - common mitigation for some ERC20 bugs
      logger.warn(
        `Existing allowance (${ethers.formatUnits(currentAllowance)}) is less than required. Resetting to 0 before approving new amount.`
      );
      try {
        const resetTxHash = await this._sendApproveTx(tokenContract, spenderAddress, 0n);
        await l1Provider.waitForTransaction(resetTxHash, 1, 120000); // Wait for reset confirmation
      } catch (error) {
        logger.error('Failed to reset ERC20 allowance to 0:', error);
        throw new Error('Failed to reset existing allowance before approving.');
      }
    }

    logger.info(
      `Approving ${spenderAddress} to spend ${ethers.formatUnits(amountWei)} of ${tokenAddressL1}...`
    );
    // Approve slightly more or MaxUint256 for simplicity, depending on strategy
    const approveAmount = MaxUint256; // Approve maximum often simplest
    const approveTxHash = await this._sendApproveTx(tokenContract, spenderAddress, approveAmount);

    logger.info(`Approve transaction sent (${approveTxHash}). Waiting for confirmation...`);
    const receipt = await l1Provider.waitForTransaction(approveTxHash, 1, 120000); // Wait 1 conf, timeout 2min

    if (!receipt || receipt.status !== 1) {
      logger.error(
        `Approve transaction (${approveTxHash}) failed or timed out. Status: ${receipt?.status}`
      );
      throw new Error(`ERC20 approval transaction failed (Hash: ${approveTxHash})`);
    }

    logger.info(`Approval confirmed for ${tokenAddressL1}.`);
    return approveTxHash;
  }

  // Internal helper to construct and send an approve transaction
  private async _sendApproveTx(
    tokenContract: Contract,
    spender: string,
    amount: bigint
  ): Promise<string> {
    const signer = this.getL1Signer();
    const l1Provider = this.getProvider('L1');

    try {
      const txData = await tokenContract.approve.populateTransaction(spender, amount);

      const { maxFeePerGas, maxPriorityFeePerGas } = await this._getL1FeeDetails();

      const gasLimit = await signer.estimateGas({ ...txData });
      const gasLimitBuffered = (gasLimit * 150n) / 100n; // Increase buffer for approve? 50%

      const tx: TransactionRequest = {
        ...txData,
        gasLimit: gasLimitBuffered,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        chainId: (await l1Provider.getNetwork()).chainId,
      };

      // Get current nonce before signing
      const nonce = await signer.getNonce();
      tx.nonce = nonce;

      logger.debug('Signing approve transaction...', tx);
      const signedTx = await signer.signTransaction(tx);
      logger.info(`Broadcasting L1 approve transaction for token ${tokenContract.target}...`);
      const txResponse = await this.sendRawTransaction(signedTx, 'L1');
      return txResponse.hash;
    } catch (error: unknown) {
      logger.error(`ERC20 approve transaction failed for token ${tokenContract.target}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Approval failed: ${errorMessage}`);
    }
  }

  // Helper for L1 Fee Details
  private async _getL1FeeDetails(): Promise<{
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  }> {
    if (!this.l1Provider) throw new Error('L1 provider not initialized for fee data.');
    // Runtime check is inside getGasPriceEstimates, but good to be explicit if we use it directly often
    if (!this.runtime) throw new Error('Runtime not available for GasService access.');

    try {
      logger.debug('Fetching gas prices from GasService...');
      const gasServiceEstimates = await getGasPriceEstimates(this.runtime);
      // Check if GasService provided sufficient EIP-1559 data
      if (
        gasServiceEstimates?.estimatedBaseFee &&
        gasServiceEstimates?.average?.maxPriorityFeePerGas
      ) {
        const maxPriorityFeePerGas = gasServiceEstimates.average.maxPriorityFeePerGas;
        const maxFeePerGas = gasServiceEstimates.estimatedBaseFee + maxPriorityFeePerGas;

        // Log the values to help diagnose issues
        logger.debug('Gas price details from GasService:', {
          baseFeeWei: gasServiceEstimates.estimatedBaseFee?.toString(),
          baseFeeGwei: ethers.formatUnits(gasServiceEstimates.estimatedBaseFee || 0n, 'gwei'),
          priorityFeeWei: maxPriorityFeePerGas.toString(),
          priorityFeeGwei: ethers.formatUnits(maxPriorityFeePerGas, 'gwei'),
          totalFeeWei: maxFeePerGas.toString(),
          totalFeeGwei: ethers.formatUnits(maxFeePerGas, 'gwei'),
        });

        // Compare numbers, not strings, and warn only above ~500 gwei
        if (Number(ethers.formatUnits(maxFeePerGas, 'gwei')) > 500) {
          logger.warn(
            `Unusually high gas price (${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei) – double-check the fee source or unit conversion.`
          );
        }

        logger.debug('Using L1 fee details from GasService.');
        return { maxFeePerGas, maxPriorityFeePerGas };
      }
    } catch (gsError: unknown) {
      logger.warn(
        `GasService call failed or returned insufficient data: ${gsError instanceof Error ? gsError.message : String(gsError)}. Falling back to l1Provider.getFeeData().`
      );
    }

    // Fallback to l1Provider.getFeeData()
    logger.debug('Falling back to l1Provider.getFeeData() for L1 fee details.');
    const feeData = await this.l1Provider.getFeeData();
    let maxFeePerGas = feeData.maxFeePerGas;
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;

    if (maxFeePerGas === null || maxPriorityFeePerGas === null) {
      if (feeData.gasPrice !== null) {
        logger.warn(
          'L1 fee data: maxFeePerGas or maxPriorityFeePerGas is null, using gasPrice as fallback (legacy transaction type).'
        );
        // For legacy tx, or if EIP-1559 not fully supported by provider via getFeeData, use gasPrice.
        // maxFeePerGas and maxPriorityFeePerGas will effectively be the same as gasPrice.
        maxFeePerGas = feeData.gasPrice;
        maxPriorityFeePerGas = feeData.gasPrice;
      } else {
        throw new Error(
          'Unable to obtain L1 fee data: getFeeData() returned all null for EIP-1559 fields and gasPrice.'
        );
      }
    }

    if (maxFeePerGas === null || maxPriorityFeePerGas === null) {
      // This should ideally not be reached if gasPrice fallback worked.
      throw new Error('Unable to determine L1 fee details even after fallback attempts.');
    }

    // Log the values from provider.getFeeData() as well
    logger.debug('Gas price details from provider.getFeeData():', {
      maxFeePerGasWei: maxFeePerGas.toString(),
      maxFeePerGasGwei: ethers.formatUnits(maxFeePerGas, 'gwei'),
      maxPriorityFeePerGasWei: maxPriorityFeePerGas.toString(),
      maxPriorityFeePerGasGwei: ethers.formatUnits(maxPriorityFeePerGas, 'gwei'),
    });

    // Compare numbers, not strings, and warn only above ~500 gwei
    if (Number(ethers.formatUnits(maxFeePerGas, 'gwei')) > 500) {
      logger.warn(
        `Unusually high gas price from provider (${ethers.formatUnits(maxFeePerGas, 'gwei')} gwei) – double-check the fee source or unit conversion.`
      );
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  // --- L2 Checkpoint Status Check (L1) ---

  /**
   * Fetches the last L2 block number included in a checkpoint on L1.
   * @returns A promise resolving to the last checkpointed L2 block number as a bigint.
   */
  async getLastCheckpointedL2Block(): Promise<bigint> {
    logger.debug(
      'Getting last checkpointed L2 block number from L1 RootChainManager/CheckpointManager...'
    );
    try {
      // Get RootChainManager contract
      const rootChainManager = this.getRootChainManagerContract();
      if (!this.l1Provider) {
        throw new Error('L1 provider not initialized for CheckpointManager interaction.');
      }

      // Get CheckpointManager address
      logger.debug('Retrieving CheckpointManager address from RootChainManager...');
      let checkpointManagerAddr: string;
      try {
        checkpointManagerAddr = await rootChainManager.checkpointManagerAddress();
        logger.debug(`CheckpointManager address retrieved: ${checkpointManagerAddr}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to get checkpointManagerAddress from RootChainManager: ${errMsg}`);
        logger.debug('RootChainManager contract details:', {
          address: ROOT_CHAIN_MANAGER_ADDRESS_L1,
          methods: rootChainManager.interface.fragments
            .map((f: { name?: string }) => (typeof f === 'object' && f.name ? f.name : 'unnamed'))
            .join(', '),
        });
        throw new Error(`Failed to get CheckpointManager address from RootChainManager: ${errMsg}`);
      }

      if (!checkpointManagerAddr || checkpointManagerAddr === ZeroAddress) {
        logger.error('Invalid CheckpointManager address:', checkpointManagerAddr);
        throw new Error(
          'CheckpointManager address not found or is zero address from RootChainManager.'
        );
      }

      // Create CheckpointManager contract instance
      logger.debug(
        `Creating CheckpointManager contract instance for address: ${checkpointManagerAddr}...`
      );
      const checkpointManager = new Contract(
        checkpointManagerAddr,
        CheckpointManagerABI,
        this.l1Provider
      );

      // Test if contract exists at the address by calling a simple view function
      try {
        // Try to call a simple method first to check if contract exists and responds
        await this.l1Provider.getCode(checkpointManagerAddr);
        logger.debug('Contract code exists at CheckpointManager address');
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to verify CheckpointManager contract at ${checkpointManagerAddr}: ${errMsg}`
        );
        throw new Error(
          `CheckpointManager contract not found at ${checkpointManagerAddr}: ${errMsg}`
        );
      }

      // Get current header block number
      logger.debug('Retrieving currentHeaderBlock from CheckpointManager...');
      let lastHeaderNum: bigint;
      try {
        lastHeaderNum = await checkpointManager.currentHeaderBlock();
        logger.debug(`Last header block number: ${lastHeaderNum}`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to retrieve currentHeaderBlock from CheckpointManager: ${errMsg}`);
        logger.debug('CheckpointManager contract details:', {
          address: checkpointManagerAddr,
          methods: checkpointManager.interface.fragments
            .map((f: { name?: string }) => (typeof f === 'object' && f.name ? f.name : 'unnamed'))
            .join(', '),
        });
        throw new Error(`Failed to retrieve currentHeaderBlock from CheckpointManager: ${errMsg}`);
      }

      if (lastHeaderNum === undefined || lastHeaderNum === null) {
        logger.error('Invalid currentHeaderBlock value:', lastHeaderNum);
        throw new Error('Failed to retrieve currentHeaderBlock from CheckpointManager.');
      }

      // Get header block details
      logger.debug(`Retrieving header block details for block ${lastHeaderNum}...`);
      let headerBlockDetails: Record<string, unknown>;
      try {
        headerBlockDetails = await checkpointManager.headerBlocks(lastHeaderNum);
        logger.debug(
          'HeaderBlock details retrieved:',
          JSON.stringify(headerBlockDetails, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
        );
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to retrieve headerBlocks(${lastHeaderNum}) from CheckpointManager: ${errMsg}`
        );
        throw new Error(
          `Failed to retrieve headerBlock details for block ${lastHeaderNum}: ${errMsg}`
        );
      }

      if (!headerBlockDetails) {
        logger.error('headerBlockDetails is null or undefined');
        throw new Error('Failed to retrieve headerBlock details: null or undefined result.');
      }

      // Verify that endBlock exists and is valid
      // The headerBlocks function returns a struct that might be represented as an array-like object
      // with numeric indices or a map with named properties, depending on the ethers.js version

      // First, try accessing it as a named property (endBlock or end)
      let endBlock = headerBlockDetails.endBlock || headerBlockDetails.end;

      // If not found, it might be at index 2 as per the ABI definition (root, start, end, ...)
      if (endBlock === undefined && Array.isArray(headerBlockDetails)) {
        endBlock = headerBlockDetails[2];
      } else if (endBlock === undefined && typeof headerBlockDetails === 'object') {
        // Try numeric indices if it's an object with numeric keys
        endBlock = headerBlockDetails[2];
      }

      if (endBlock === undefined || endBlock === null) {
        logger.error(
          'endBlock not found or is null in headerBlockDetails, full details:',
          JSON.stringify(headerBlockDetails, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
        );
        throw new Error('Failed to retrieve endBlock from headerBlockDetails.');
      }

      // Convert to bigint
      const lastBlock = BigInt(endBlock.toString());
      logger.info(`Last L2 block checkpointed on L1 (via CheckpointManager): ${lastBlock}`);
      return lastBlock;
    } catch (error: unknown) {
      logger.error('Error fetching last checkpointed L2 block from L1:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Rethrow with a more specific message
      throw new Error(`Failed to get last checkpointed L2 block: ${errorMessage}`);
    }
  }

  /**
   * Checks if a given Polygon L2 block number has been included in a checkpoint on L1.
   * @param l2BlockNumber The L2 block number to check.
   * @returns A promise resolving to true if the block is checkpointed, false otherwise.
   */
  async isL2BlockCheckpointed(l2BlockNumber: number | bigint): Promise<boolean> {
    const targetBlock = BigInt(l2BlockNumber.toString());
    logger.debug(`Checking if L2 block ${targetBlock} is checkpointed on L1...`);
    try {
      logger.debug('Retrieving last checkpointed block from L1...');
      const lastCheckpointedBlock = await this.getLastCheckpointedL2Block();

      logger.debug(
        `Comparing target block ${targetBlock} with last checkpointed block ${lastCheckpointedBlock}`
      );
      const isCheckpointed = targetBlock <= lastCheckpointedBlock;

      logger.info(
        `L2 block ${targetBlock} checkpointed status: ${isCheckpointed} (Last Checkpointed: ${lastCheckpointedBlock})`
      );
      return isCheckpointed;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `Could not determine checkpoint status for L2 block ${targetBlock} due to error fetching last checkpoint: ${errorMessage}`,
        error
      );

      // Consistent with user plan: if getLastCheckpointedL2Block fails, this should also fail rather than return false.
      throw new Error(
        `Failed to determine checkpoint status for L2 block ${targetBlock}: ${errorMessage}`
      );
    }
  }
}
