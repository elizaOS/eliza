import { IAgentRuntime, logger } from '@elizaos/core';
import { Connection, clusterApiUrl, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const DEFAULT_ENDPOINT = clusterApiUrl('mainnet-beta');
const DEFAULT_COMMITMENT = 'confirmed';

/**
 * Gets a Solana RPC connection configured from runtime settings
 */
export function getConnection(runtime: IAgentRuntime): Connection {
  const rpcUrl = runtime.getSetting('SOLANA_RPC_URL') || runtime.getSetting('RPC_URL') || DEFAULT_ENDPOINT;
  const commitmentRaw = runtime.getSetting('SOLANA_COMMITMENT') || DEFAULT_COMMITMENT;
  const commitment = typeof commitmentRaw === 'string' ? commitmentRaw : DEFAULT_COMMITMENT;
  
  return new Connection(rpcUrl as string, commitment as 'confirmed' | 'finalized' | 'processed');
}

export function getWalletPublicKey(runtime: IAgentRuntime): string | null {
  const pubKey = runtime.getSetting('SOLANA_PUBLIC_KEY');
  return pubKey && typeof pubKey === 'string' ? pubKey : null;
}

export function getWalletPrivateKey(runtime: IAgentRuntime): string | null {
  const privKey = runtime.getSetting('SOLANA_PRIVATE_KEY');
  return privKey && typeof privKey === 'string' ? privKey : null;
}

/**
 * Wallet result containing either a signer or public address
 */
export interface WalletResult {
  signer?: Keypair;
  address: PublicKey;
}

/**
 * Loads a Solana wallet from runtime settings
 * @param runtime The agent runtime
 * @param requirePrivateKey Whether to require a full keypair (true) or just public key (false)
 * @returns WalletResult containing either keypair or public key
 */
export async function loadWallet(
  runtime: IAgentRuntime,
  requirePrivateKey: boolean = true
): Promise<WalletResult> {
  if (requirePrivateKey) {
    const privateKeyString = getWalletPrivateKey(runtime);

    if (!privateKeyString) {
      throw new Error('SOLANA_PRIVATE_KEY not found in settings');
    }

    try {
      // First try base58
      const secretKey = bs58.decode(privateKeyString);
      const signer = Keypair.fromSecretKey(secretKey);
      return { signer, address: signer.publicKey };
    } catch (e) {
      logger.debug('Error decoding base58 private key, trying base64...');
      try {
        // Then try base64
        const secretKey = Uint8Array.from(Buffer.from(privateKeyString, 'base64'));
        const signer = Keypair.fromSecretKey(secretKey);
        return { signer, address: signer.publicKey };
      } catch (e2) {
        logger.error('Error decoding private key:', e2);
        throw new Error('Invalid private key format - must be base58 or base64 encoded');
      }
    }
  } else {
    // Check if we have a private key we can derive address from
    const privateKeyString = getWalletPrivateKey(runtime);
    if (privateKeyString) {
      try {
        const secretKey = bs58.decode(privateKeyString);
        const keypair = Keypair.fromSecretKey(secretKey);
        return { address: keypair.publicKey };
      } catch {
        // Fall through to public key check
      }
    }

    const publicKeyString = getWalletPublicKey(runtime);
    if (!publicKeyString) {
      throw new Error('SOLANA_PUBLIC_KEY or SOLANA_PRIVATE_KEY not found in settings');
    }

    return { address: new PublicKey(publicKeyString) };
  }
}

/**
 * Sends a transaction with proper error handling and confirmation
 */
export async function sendTransaction(
  connection: Connection,
  instructions: import('@solana/web3.js').TransactionInstruction[],
  signer: Keypair
): Promise<string> {
  const { Transaction } = await import('@solana/web3.js');
  
  const transaction = new Transaction();
  transaction.add(...instructions);
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = signer.publicKey;
  
  transaction.sign(signer);
  
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  
  await connection.confirmTransaction({
    blockhash,
    lastValidBlockHeight,
    signature,
  });
  
  return signature;
}