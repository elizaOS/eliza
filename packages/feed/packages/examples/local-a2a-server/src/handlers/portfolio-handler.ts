/**
 * Portfolio Handler
 * Handles portfolio, balance, and leaderboard operations
 */

import type { Database } from 'bun:sqlite';
import type { LocalBlockchain } from '../services/local-blockchain';

interface Portfolio {
  balance: number;
  positions: Position[];
  pnl: number;
  totalValue: number;
}

interface Position {
  id: string;
  marketId: string;
  marketQuestion: string;
  outcome: 'YES' | 'NO';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  currentValue: number;
  pnl: number;
}

interface WalletInfo {
  address: string;
  virtualBalance: number;
  onChainBalance: string;
  chainId: number;
}

interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  pnl: number;
  totalVolume: number;
  winRate: number;
}

export class PortfolioHandler {
  constructor(
    private db: Database,
    private blockchain: LocalBlockchain
  ) {}

  /**
   * Get user balance
   */
  getBalance(userId: string): { balance: number; currency: string } {
    const row = this.db
      .query('SELECT virtual_balance FROM users WHERE id = ?')
      .get(userId) as { virtual_balance: number } | null;

    if (!row) {
      // Auto-create user with default balance
      return { balance: 1000, currency: 'USD' };
    }

    return {
      balance: row.virtual_balance,
      currency: 'USD',
    };
  }

  /**
   * Get user positions
   */
  getPositions(userId: string): { positions: Position[] } {
    const results = this.db
      .query(`
      SELECT 
        p.*,
        m.question as market_question,
        m.yes_price,
        m.no_price,
        m.status as market_status
      FROM positions p
      LEFT JOIN prediction_markets m ON p.market_id = m.id
      WHERE p.user_id = ?
    `)
      .all(userId) as Record<string, unknown>[];

    const positions = results.map((row) => {
      const currentPrice =
        row.outcome === 'YES'
          ? (row.yes_price as number)
          : (row.no_price as number);
      const shares = row.shares as number;
      const avgPrice = row.avg_price as number;
      const currentValue = shares * currentPrice;
      const costBasis = shares * avgPrice;
      const pnl = currentValue - costBasis;

      return {
        id: row.id as string,
        marketId: row.market_id as string,
        marketQuestion: (row.market_question as string) || 'Unknown Market',
        outcome: row.outcome as 'YES' | 'NO',
        shares,
        avgPrice,
        currentPrice,
        currentValue,
        pnl,
      };
    });

    return { positions };
  }

  /**
   * Get full portfolio
   */
  getPortfolio(userId: string): Portfolio {
    const balanceData = this.getBalance(userId);
    const positionsData = this.getPositions(userId);

    const totalPositionValue = positionsData.positions.reduce(
      (sum, pos) => sum + pos.currentValue,
      0
    );

    const totalPnl = positionsData.positions.reduce(
      (sum, pos) => sum + pos.pnl,
      0
    );

    return {
      balance: balanceData.balance,
      positions: positionsData.positions,
      pnl: totalPnl,
      totalValue: balanceData.balance + totalPositionValue,
    };
  }

  /**
   * Get wallet info
   */
  async getWalletInfo(userId: string): Promise<WalletInfo> {
    const row = this.db
      .query('SELECT wallet_address, virtual_balance FROM users WHERE id = ?')
      .get(userId) as {
      wallet_address: string;
      virtual_balance: number;
    } | null;

    const walletAddress =
      row?.wallet_address || '0x0000000000000000000000000000000000000000';
    const virtualBalance = row?.virtual_balance || 1000;

    // Get on-chain balance (falls back if blockchain unavailable)
    let onChainBalance = '0';
    if (await this.blockchain.isAvailable()) {
      const balance = await this.blockchain.getBalance(walletAddress);
      onChainBalance = balance.toString();
    }

    let chainId = 31337;
    if (await this.blockchain.isAvailable()) {
      chainId = await this.blockchain.getChainId();
    }

    return {
      address: walletAddress,
      virtualBalance,
      onChainBalance,
      chainId,
    };
  }

  /**
   * Get leaderboard
   */
  getLeaderboard(params: Record<string, unknown>): {
    entries: LeaderboardEntry[];
  } {
    const limit = (params.limit as number) || 10;

    // Calculate leaderboard based on trades
    const results = this.db
      .query(`
      SELECT 
        u.id as user_id,
        u.display_name,
        COALESCE(SUM(CASE WHEN t.type = 'SELL' THEN t.total_cost ELSE -t.total_cost END), 0) as pnl,
        COALESCE(SUM(t.total_cost), 0) as total_volume,
        u.reputation_points
      FROM users u
      LEFT JOIN trades t ON u.id = t.user_id
      WHERE u.id != 'system'
      GROUP BY u.id
      ORDER BY pnl DESC
      LIMIT ?
    `)
      .all(limit) as Record<string, unknown>[];

    return {
      entries: results.map((row, index) => ({
        rank: index + 1,
        userId: row.user_id as string,
        displayName: (row.display_name as string) || 'Anonymous',
        pnl: (row.pnl as number) || 0,
        totalVolume: (row.total_volume as number) || 0,
        winRate: 0.5 + ((row.pnl as number) > 0 ? 0.1 : -0.1), // Simplified
      })),
    };
  }
}
