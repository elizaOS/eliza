import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";

export interface TreasuryMetrics {
  totalBandwidthBytesRelayed: number;
  userEarnedLamports: number;
  treasuryEarnedLamports: number;
  publishedHeuristicsCount: number;
}

export class TreasuryEngine {
  private treasuryWallet = new PublicKey("VALHa11aTreasury111111111111111111111111111");
  private protocolFeeRate = 0.15; // 15% protocol fee
  private metrics: TreasuryMetrics = {
    totalBandwidthBytesRelayed: 0,
    userEarnedLamports: 0,
    treasuryEarnedLamports: 0,
    publishedHeuristicsCount: 0
  };

  /**
   * Split DePIN micro-earnings between user reserve wallet and community treasury
   */
  async buildFeeSplitTransaction(
    payerPubkey: PublicKey,
    grossLamports: number
  ): Promise<Transaction> {
    const userWalletPubkey = new PublicKey(
      process.env.SOLANA_RESERVE_WALLET || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
    );

    const treasuryShare = Math.floor(grossLamports * this.protocolFeeRate);
    const userShare = grossLamports - treasuryShare;

    const tx = new Transaction();

    // 85% to personal reserve wallet
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: userWalletPubkey,
        lamports: userShare
      })
    );

    // 15% to Valhalla Treasury
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payerPubkey,
        toPubkey: this.treasuryWallet,
        lamports: treasuryShare
      })
    );

    this.metrics.userEarnedLamports += userShare;
    this.metrics.treasuryEarnedLamports += treasuryShare;
    this.metrics.totalBandwidthBytesRelayed += 50 * 1024 * 1024; // 50MB per pulse increment

    return tx;
  }

  getMetrics(): TreasuryMetrics {
    return { ...this.metrics };
  }
}
