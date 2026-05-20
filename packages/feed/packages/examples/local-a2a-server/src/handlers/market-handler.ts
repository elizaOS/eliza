/**
 * Market Handler
 * Handles prediction market operations
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

interface Market {
  id: string;
  question: string;
  description: string;
  yesPrice: number;
  noPrice: number;
  totalVolume: number;
  yesShares: number;
  noShares: number;
  resolutionDate: string;
  status: string;
  createdAt: string;
}

interface Position {
  id: string;
  marketId: string;
  outcome: "YES" | "NO";
  shares: number;
  avgPrice: number;
}

interface Trade {
  id: string;
  marketId: string;
  outcome: "YES" | "NO";
  type: "BUY" | "SELL";
  shares: number;
  price: number;
  totalCost: number;
  timestamp: string;
}

export class MarketHandler {
  constructor(private db: Database) {}

  /**
   * Get all markets
   */
  getMarkets(params: Record<string, unknown>): {
    predictions: Market[];
    perps: Market[];
  } {
    const limit = (params.limit as number) || 20;
    const status = params.status as string | undefined;

    let query = "SELECT * FROM prediction_markets WHERE 1=1";
    const queryParams: (string | number)[] = [];

    if (status) {
      query += " AND status = ?";
      queryParams.push(status);
    }
    query += " ORDER BY total_volume DESC LIMIT ?";
    queryParams.push(limit);

    const results = this.db.query(query).all(...queryParams) as Record<
      string,
      unknown
    >[];

    const predictions = results.map((row) => this.rowToMarket(row));

    // Return both prediction markets and mock perps
    return {
      predictions,
      perps: [
        {
          id: "perp-btc-usd",
          question: "BTC-USD Perpetual",
          description: "Bitcoin perpetual futures",
          yesPrice: 97500,
          noPrice: 0,
          totalVolume: 50000000,
          yesShares: 0,
          noShares: 0,
          resolutionDate: "",
          status: "open",
          createdAt: new Date().toISOString(),
        },
        {
          id: "perp-eth-usd",
          question: "ETH-USD Perpetual",
          description: "Ethereum perpetual futures",
          yesPrice: 3500,
          noPrice: 0,
          totalVolume: 25000000,
          yesShares: 0,
          noShares: 0,
          resolutionDate: "",
          status: "open",
          createdAt: new Date().toISOString(),
        },
      ],
    };
  }

  /**
   * Get specific market data
   */
  getMarketData(marketId: string): Market {
    const row = this.db
      .query("SELECT * FROM prediction_markets WHERE id = ?")
      .get(marketId) as Record<string, unknown> | null;

    if (!row) {
      throw new Error(`Market not found: ${marketId}`);
    }

    return this.rowToMarket(row);
  }

  /**
   * Get prices for multiple markets
   */
  getMarketPrices(
    marketIds: string[],
  ): Record<string, { yes: number; no: number }> {
    if (!marketIds || marketIds.length === 0) {
      return {};
    }

    const placeholders = marketIds.map(() => "?").join(",");
    const results = this.db
      .query(
        `SELECT id, yes_price, no_price FROM prediction_markets WHERE id IN (${placeholders})`,
      )
      .all(...marketIds) as Record<string, unknown>[];

    const prices: Record<string, { yes: number; no: number }> = {};
    for (const row of results) {
      prices[row.id as string] = {
        yes: row.yes_price as number,
        no: row.no_price as number,
      };
    }

    return prices;
  }

  /**
   * Buy shares in a market
   */
  buyShares(
    userId: string,
    marketId: string,
    outcome: "YES" | "NO",
    amount: number,
  ): Trade {
    // Get market
    const market = this.getMarketData(marketId);

    if (market.status !== "open") {
      throw new Error("Market is not open for trading");
    }

    // Calculate shares (simple CPMM)
    const price = outcome === "YES" ? market.yesPrice : market.noPrice;
    const shares = amount / price;

    // Deduct balance from user
    this.deductUserBalance(userId, amount);

    // Update or create position
    this.updatePosition(userId, marketId, outcome, shares, price);

    // Record trade
    const tradeId = randomUUID();
    this.db.run(
      `
      INSERT INTO trades (id, user_id, market_id, type, outcome, shares, price, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      tradeId,
      userId,
      marketId,
      "BUY",
      outcome,
      shares,
      price,
      amount,
    );

    // Update market volume and prices
    this.updateMarketAfterTrade(marketId, outcome, "BUY", shares, amount);

    return {
      id: tradeId,
      marketId,
      outcome,
      type: "BUY",
      shares,
      price,
      totalCost: amount,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sell shares in a market
   */
  sellShares(
    userId: string,
    marketId: string,
    outcome: "YES" | "NO",
    sharesToSell: number,
  ): Trade {
    // Get market
    const market = this.getMarketData(marketId);

    if (market.status !== "open") {
      throw new Error("Market is not open for trading");
    }

    // Get user position
    const position = this.getPosition(userId, marketId, outcome);
    if (!position || position.shares < sharesToSell) {
      throw new Error("Insufficient shares to sell");
    }

    // Calculate payout
    const price = outcome === "YES" ? market.yesPrice : market.noPrice;
    const payout = sharesToSell * price;

    // Update position
    const newShares = position.shares - sharesToSell;
    if (newShares > 0) {
      this.db.run(
        "UPDATE positions SET shares = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        newShares,
        position.id,
      );
    } else {
      this.db.run("DELETE FROM positions WHERE id = ?", position.id);
    }

    // Credit balance to user
    this.creditUserBalance(userId, payout);

    // Record trade
    const tradeId = randomUUID();
    this.db.run(
      `
      INSERT INTO trades (id, user_id, market_id, type, outcome, shares, price, total_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      tradeId,
      userId,
      marketId,
      "SELL",
      outcome,
      sharesToSell,
      price,
      payout,
    );

    // Update market
    this.updateMarketAfterTrade(
      marketId,
      outcome,
      "SELL",
      sharesToSell,
      payout,
    );

    return {
      id: tradeId,
      marketId,
      outcome,
      type: "SELL",
      shares: sharesToSell,
      price,
      totalCost: payout,
      timestamp: new Date().toISOString(),
    };
  }

  private getPosition(
    userId: string,
    marketId: string,
    outcome: string,
  ): Position | null {
    const row = this.db
      .query(`
      SELECT * FROM positions 
      WHERE user_id = ? AND market_id = ? AND outcome = ?
    `)
      .get(userId, marketId, outcome) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      marketId: row.market_id as string,
      outcome: row.outcome as "YES" | "NO",
      shares: row.shares as number,
      avgPrice: row.avg_price as number,
    };
  }

  private updatePosition(
    userId: string,
    marketId: string,
    outcome: string,
    newShares: number,
    price: number,
  ): string {
    const existing = this.getPosition(userId, marketId, outcome);

    if (existing) {
      // Calculate new average price
      const totalShares = existing.shares + newShares;
      const totalCost = existing.shares * existing.avgPrice + newShares * price;
      const newAvgPrice = totalCost / totalShares;

      this.db.run(
        "UPDATE positions SET shares = ?, avg_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        totalShares,
        newAvgPrice,
        existing.id,
      );

      return existing.id;
    }

    const positionId = randomUUID();
    this.db.run(
      `
      INSERT INTO positions (id, user_id, market_id, outcome, shares, avg_price)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      positionId,
      userId,
      marketId,
      outcome,
      newShares,
      price,
    );

    return positionId;
  }

  private deductUserBalance(userId: string, amount: number): void {
    const row = this.db
      .query("SELECT virtual_balance FROM users WHERE id = ?")
      .get(userId) as { virtual_balance: number } | null;

    if (!row) {
      // Try to find by wallet address (in case agentId format changed)
      // Or create user with default balance
      this.ensureUserExists(userId);
      return this.deductUserBalance(userId, amount);
    }

    const balance = row.virtual_balance;
    if (balance < amount) {
      throw new Error("Insufficient balance");
    }

    this.db.run(
      "UPDATE users SET virtual_balance = virtual_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      amount,
      userId,
    );
  }

  private ensureUserExists(userId: string): void {
    const existing = this.db
      .query("SELECT id FROM users WHERE id = ?")
      .get(userId);
    if (existing) return;

    // Create user with default balance
    const username = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.run(
      `
      INSERT OR IGNORE INTO users (
        id, wallet_address, display_name, username, bio, virtual_balance, reputation_points
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      userId,
      `0x${userId.slice(-40).padStart(40, "0")}`,
      `Agent ${userId.slice(-8)}`,
      username,
      "Autonomous agent",
      1000,
      100,
    );
  }

  private creditUserBalance(userId: string, amount: number): void {
    this.db.run(
      "UPDATE users SET virtual_balance = virtual_balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      amount,
      userId,
    );
  }

  private updateMarketAfterTrade(
    marketId: string,
    outcome: string,
    type: "BUY" | "SELL",
    shares: number,
    volume: number,
  ): void {
    // Update total volume
    this.db.run(
      "UPDATE prediction_markets SET total_volume = total_volume + ? WHERE id = ?",
      volume,
      marketId,
    );

    // Update shares and prices (simplified CPMM)
    const market = this.getMarketData(marketId);
    const yesShares = market.yesShares;
    const noShares = market.noShares;

    const shareChange = type === "BUY" ? shares : -shares;

    if (outcome === "YES") {
      const newYesShares = Math.max(0.01, yesShares + shareChange);
      const newYesPrice = Math.min(
        0.99,
        Math.max(0.01, noShares / (noShares + newYesShares)),
      );
      const newNoPrice = 1 - newYesPrice;

      this.db.run(
        "UPDATE prediction_markets SET yes_shares = ?, yes_price = ?, no_price = ? WHERE id = ?",
        newYesShares,
        newYesPrice,
        newNoPrice,
        marketId,
      );
    } else {
      const newNoShares = Math.max(0.01, noShares + shareChange);
      const newNoPrice = Math.min(
        0.99,
        Math.max(0.01, yesShares / (yesShares + newNoShares)),
      );
      const newYesPrice = 1 - newNoPrice;

      this.db.run(
        "UPDATE prediction_markets SET no_shares = ?, yes_price = ?, no_price = ? WHERE id = ?",
        newNoShares,
        newYesPrice,
        newNoPrice,
        marketId,
      );
    }
  }

  /**
   * Get market statistics for system stats
   */
  getMarketStats(): {
    totalMarkets: number;
    totalVolume: number;
    totalTrades: number;
  } {
    const marketRow = this.db
      .query(
        "SELECT COUNT(*) as count, COALESCE(SUM(total_volume), 0) as volume FROM prediction_markets",
      )
      .get() as { count: number; volume: number };
    const tradeRow = this.db
      .query("SELECT COUNT(*) as count FROM trades")
      .get() as { count: number };

    return {
      totalMarkets: marketRow.count,
      totalVolume: marketRow.volume,
      totalTrades: tradeRow.count,
    };
  }

  private rowToMarket(row: Record<string, unknown>): Market {
    return {
      id: row.id as string,
      question: row.question as string,
      description: (row.description as string) || "",
      yesPrice: row.yes_price as number,
      noPrice: row.no_price as number,
      totalVolume: row.total_volume as number,
      yesShares: (row.yes_shares as number) || 0,
      noShares: (row.no_shares as number) || 0,
      resolutionDate: (row.resolution_date as string) || "",
      status: row.status as string,
      createdAt: row.created_at as string,
    };
  }
}
