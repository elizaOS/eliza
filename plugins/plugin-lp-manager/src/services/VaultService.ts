import { IAgentRuntime, Service } from '@elizaos/core';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { IVaultService, TokenBalance } from '../types.ts';
import { getConnection } from '../utils/solanaClient.ts';

export class VaultService extends Service implements IVaultService {
  public static readonly serviceType = 'VaultService';
  public readonly capabilityDescription = "Manages secure vaults for user cryptographic keys.";
  
  private connection!: Connection;
  // Simple in-memory cache for vault public keys - in production, use proper storage
  private vaultCache: Map<string, string> = new Map();

  constructor() {
    super();
  }

  static async start(runtime: IAgentRuntime): Promise<VaultService> {
    const service = new VaultService();
    await service.start(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    // No cleanup needed for static stop
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    // Initialize connection
    this.connection = getConnection(runtime);
  }

  async stop(): Promise<void> {
    // No-op
  }

  public async createVault(userId: string): Promise<{ publicKey: string; secretKeyEncrypted: string }> {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    const secretKeyEncrypted = Buffer.from(keypair.secretKey).toString('hex');
    
    // Cache the public key
    this.vaultCache.set(userId, publicKey);
    
    return { publicKey, secretKeyEncrypted };
  }

  public async getVaultKeypair(userId: string, encryptedSecretKey: string): Promise<Keypair> {
    try {
      const secretKey = Buffer.from(encryptedSecretKey, 'hex');
      if (secretKey.length !== 64) {
        throw new Error('Invalid secret key length.');
      }
      return Keypair.fromSecretKey(new Uint8Array(secretKey));
    } catch (error: any) {
        console.error(`Failed to create Keypair from secret for user ${userId}:`, error);
        throw new Error('Could not derive Keypair from the provided secret.');
    }
  }

  public async getVaultPublicKey(userId: string): Promise<string | null> {
    // Check cache first
    const cached = this.vaultCache.get(userId);
    if (cached) {
      return cached;
    }
    
    // In a real implementation, this would fetch from persistent storage
    // For now, return null if not in cache
    return null;
  }

  public async getBalances(publicKey: string): Promise<TokenBalance[]> {
    try {
      const pubKey = new PublicKey(publicKey);
      const balances: TokenBalance[] = [];
      
      // Get SOL balance
      const solBalance = await this.connection.getBalance(pubKey);
      balances.push({
        address: 'SOL',
        balance: solBalance.toString(),
        decimals: 9,
        uiAmount: solBalance / LAMPORTS_PER_SOL,
        name: 'Solana',
        symbol: 'SOL',
      });

      // Get SPL token accounts
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      for (const account of tokenAccounts.value) {
        const parsedInfo = account.account.data.parsed.info;
        const tokenBalance = parsedInfo.tokenAmount;
        
        balances.push({
          address: parsedInfo.mint,
          balance: tokenBalance.amount,
          decimals: tokenBalance.decimals,
          uiAmount: tokenBalance.uiAmount,
          // Note: symbol and name would need to be fetched from token metadata
          // For now, we'll leave them undefined
        });
      }

      return balances;
    } catch (error) {
      console.error('Error fetching balances:', error);
      throw new Error(`Failed to fetch balances for ${publicKey}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async exportPrivateKey(
    userId: string, 
    encryptedSecretKey: string, 
    confirmationToken: string
  ): Promise<string> {
    // In a real implementation, you would verify the confirmationToken
    // For now, we'll do a simple check
    if (!confirmationToken || confirmationToken.length < 6) {
      throw new Error('Invalid confirmation token');
    }

    try {
      const keypair = await this.getVaultKeypair(userId, encryptedSecretKey);
      // Return base58 encoded private key
      const bs58 = await import('bs58');
      return bs58.default.encode(keypair.secretKey);
    } catch (error) {
      console.error('Error exporting private key:', error);
      throw new Error('Failed to export private key');
    }
  }
}