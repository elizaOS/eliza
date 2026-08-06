```typescript
import { 
  Connection, 
  PublicKey, 
  Logs, 
  Context, 
  ParsedTransactionWithMeta, 
  Commitment,
  ParsedAccountInfo,
  TokenBalance
} from "@solana/web3.js";

// Jupiter V6 Program ID
const JUPITER_V6_PROGRAM_ID = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface JupiterSwapMonitorConfig {
  rpcUrl: string;
  commitment?: Commitment;
  onSwap?: (swap: SwapEvent) => void;
  onError?: (error: Error) => void;
}

export interface SwapEvent {
  signature: string;
  slot: number;
  userWallet: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  timestamp?: number | null;
}

export class JupiterSwapMonitor {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private config: Required<JupiterSwapMonitorConfig>;

  constructor(config: JupiterSwapMonitorConfig) {
    this.config = {
      rpcUrl: config.rpcUrl,
      commitment: config.commitment || "confirmed",
      onSwap: config.onSwap || (() => {}),
      onError: config.onError || ((err) => console.error("JupiterSwapMonitor Error:", err)),
    };
    this.connection = new Connection(this.config.rpcUrl, this.config.commitment);
  }

  public start(): void {
    if (this.subscriptionId !== null) return;

    this.subscriptionId = this.connection.onLogs(
      JUPITER_V6_PROGRAM_ID,
      (logs: Logs, ctx: Context) => this.handleLogs(logs, ctx),
      this.config.commitment
    );

    this.connection.on("error", (err) => this.config.onError(err));
  }

  public stop(): void {
    if (this.subscriptionId !== null) {
      this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }

  private async handleLogs(logs: Logs, ctx: Context): Promise<void> {
    if (logs.err) return; // Skip failed transactions

    try {
      const tx = await this.connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: this.config.commitment,
      });

      if (!tx || !tx.meta || !tx.transaction.message.accountKeys.length) return;
      
      const swapEvent = this.extractSwapData(tx, ctx.slot);
      if (swapEvent) {
        this.config.onSwap(swapEvent);
      }
    } catch (error) {
      this.config.onError(error as Error);
    }
  }

  private extractSwapData(tx: ParsedTransactionWithMeta, slot: number): SwapEvent | null {
    const accountKeys = tx.transaction.message.accountKeys;
    const getPayerKey = (key: PublicKey | ParsedAccountInfo): string => 
      key instanceof PublicKey ? key.toString() : key.pubkey.toString();
    
    const payerKey = getPayerKey(accountKeys[0]);
    
    // Resolve owner for token balance changes
    const resolveOwner = (b: TokenBalance): string => {
      if (b.owner) return b.owner;
      const accountKey = accountKeys[b.accountIndex];
      return getPayerKey(accountKey);
    };

    // Track SPL Token changes for the payer
    const tokenChanges = new Map<string, bigint>();
    
    tx.meta.preTokenBalances?.forEach(b => {
      if (resolveOwner(b) === payerKey) {
        tokenChanges.set(b.mint, (tokenChanges.get(b.mint) || BigInt(0)) - BigInt(b.uiTokenAmount.amount));
      }
    });

    tx.meta.postTokenBalances?.forEach(b => {
      if (resolveOwner(b) === payerKey) {
        tokenChanges.set(b.mint, (tokenChanges.get(b.mint) || BigInt(0)) + BigInt(b.uiTokenAmount.amount));
      }
    });

    // Track Native SOL changes (accounting for fees)
    const preSol = BigInt(tx.meta.preBalances[0] || 0);
    const postSol = BigInt(tx.meta.postBalances[0] || 0);
    const fee = BigInt(tx.meta.fee || 0);
    const netSolDiff = (postSol - preSol) + fee;

    if (netSolDiff < BigInt(0)) {
      tokenChanges.set(WRAPPED_SOL_MINT, (tokenChanges.get(WRAPPED_SOL_MINT) || BigInt(0)) - netSolDiff);
    } else if (netSolDiff > BigInt(0)) {
      tokenChanges.set(WRAPPED_SOL_MINT, (tokenChanges.get(WRAPPED_SOL_MINT) || BigInt(0)) + netSolDiff);
    }

    // Determine input and output from balance changes
    let inputMint: string | undefined;
    let inputAmount: bigint | undefined;
    let outputMint: string | undefined;
    let outputAmount: bigint | undefined;

    for (const [mint, change] of tokenChanges.entries()) {
      if (change < BigInt(0)) {
        inputMint = mint;
        inputAmount = -change;
      } else if (change > BigInt(0)) {
        outputMint = mint;
        outputAmount = change;
      }
    }

    if (!inputMint || !outputMint || !inputAmount || !outputAmount) {
      return null; // No valid swap detected for the payer
    }

    return {
      signature: tx.transaction.signatures[0],
      slot,
      userWallet: payerKey,
      inputMint,
      outputMint,
      inputAmount: inputAmount.toString(),
      outputAmount: outputAmount.toString(),
      timestamp: tx.blockTime || null,
    };
  }
}
```