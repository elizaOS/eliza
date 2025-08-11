import { 
  Contract, 
  Wallet, 
  ContractTransactionReceipt,
  ContractTransactionResponse
} from 'ethers';
import { Address } from 'viem';

// Import ABIs from centralized location
import { ERC20ABI, RootChainManagerABI } from '../constants/abis.js';

// Import from centralized config
import { CONTRACT_ADDRESSES, TIMEOUTS } from '../config.js';

// Create a simple logger interface
interface Logger {
  info(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
}

// Use console as default logger
const logger: Logger = console;

/**
 * Initializes an ethers Contract instance with signer for the RootChainManager
 * 
 * @param signer L1 signer instance (ethers Wallet)
 * @returns Signer-aware RootChainManager contract instance
 */
export function initRootChainManagerContract(signer: Wallet): Contract {
  return new Contract(
    CONTRACT_ADDRESSES.ROOT_CHAIN_MANAGER_ADDRESS_L1,
    RootChainManagerABI,
    signer
  );
}

/**
 * Initializes an ethers Contract instance with signer for an ERC20 token
 * 
 * @param tokenAddress L1 address of the ERC20 token
 * @param signer L1 signer instance (ethers Wallet)
 * @returns Signer-aware ERC20 contract instance
 */
export function initERC20Contract(tokenAddress: string, signer: Wallet): Contract {
  return new Contract(
    tokenAddress,
    ERC20ABI,
    signer
  );
}

/**
 * Approves the RootChainManager contract to spend tokens on behalf of the user
 * 
 * @param tokenContract ERC20 contract instance
 * @param spender Address of the RootChainManager contract
 * @param amount Amount in wei to approve
 * @param gasPriceWei Optional gas price in wei
 * @returns Transaction receipt for the approval transaction
 */
export async function approveERC20(
  tokenContract: Contract,
  spender: string,
  amount: bigint,
  gasPriceWei?: bigint
): Promise<ContractTransactionReceipt | null> {
  try {
    logger.info(`Approving ${amount.toString()} tokens for RootChainManager contract...`);
    
    // Get the current allowance
    const signerAddress = await tokenContract.getAddress();
    const currentAllowance = await tokenContract.allowance(signerAddress, spender);
    
    // Skip approval if already approved for sufficient amount
    if (currentAllowance >= amount) {
      logger.info(`Approval already exists for ${amount.toString()} tokens`);
      return null;
    }
    
    // Prepare transaction options
    const options: any = {};
    if (gasPriceWei) {
      options.gasPrice = gasPriceWei;
    }
    
    // Execute the approve transaction
    const tx = await tokenContract.approve(spender, amount, options) as ContractTransactionResponse;
    logger.info(`Approval transaction submitted: ${tx.hash}`);
    
    // Wait for the transaction to be confirmed with timeout
    const receipt = await tx.wait();
    
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Approval transaction failed: ${tx.hash}`);
    }
    
    logger.info(`Approval transaction confirmed: ${tx.hash}`);
    return receipt;
  } catch (error) {
    logger.error('Error in ERC20 approval process:', error);
    throw new Error(`Failed to approve token transfer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Checks if the user has already approved the RootChainManager to spend tokens
 * 
 * @param tokenContract ERC20 contract instance
 * @param owner Address of the token owner
 * @param spender Address of the RootChainManager contract
 * @param amount Amount in wei to check against
 * @returns True if approved for the requested amount or more
 */
export async function hasApprovedERC20(
  tokenContract: Contract,
  owner: string,
  spender: string,
  amount: bigint
): Promise<boolean> {
  try {
    const allowance = await tokenContract.allowance(owner, spender);
    return allowance >= amount;
  } catch (error) {
    logger.error('Error checking token allowance:', error);
    throw new Error(`Failed to check token allowance: ${error instanceof Error ? error.message : String(error)}`);
  }
} 