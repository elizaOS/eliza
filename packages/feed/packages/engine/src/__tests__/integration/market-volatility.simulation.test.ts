/**
 * Market Volatility Simulation Test
 *
 * Comprehensive integration test that simulates real game activity
 * to verify the market volatility systems work correctly.
 *
 * Tests:
 * 1. Bonding curve price impact from NPC trades
 * 2. Price cascades during panic/FOMO scenarios
 * 3. Fee redistribution keeping NPCs liquid
 * 4. Market limits (floor, ceiling, max change) working correctly
 */

import { describe, expect, it } from 'bun:test';
import {
  BONDING_CURVE_CONFIG,
  calculateBondingCurvePrice,
  calculatePriceFromHoldings,
  PERP_MARKET_CONFIG,
} from '@feed/shared';
import { STABILITY_FUND_CONFIG } from '../../services/fee-redistribution-service';
import { MarketMomentumService } from '../../services/market-momentum-service';

/**
 * Simulates a market with price tracking over multiple trades
 */
class MarketSimulator {
  private initialPrice: number;
  private currentPrice: number;
  private netHoldings: number = 0;
  private priceHistory: number[] = [];
  private tradeHistory: Array<{
    tick: number;
    action: 'buy' | 'sell';
    amount: number;
    priceImpact: number;
    newPrice: number;
  }> = [];

  constructor(initialPrice: number) {
    this.initialPrice = initialPrice;
    this.currentPrice = initialPrice;
    this.priceHistory.push(initialPrice);
  }

  /**
   * Execute a trade and update price
   */
  trade(action: 'buy' | 'sell', amount: number, tick: number): number {
    const holdingsChange = action === 'buy' ? amount : -amount;
    this.netHoldings += holdingsChange;

    const previousPrice = this.currentPrice;
    this.currentPrice = calculatePriceFromHoldings(
      this.initialPrice,
      this.currentPrice,
      this.netHoldings,
      PERP_MARKET_CONFIG,
      BONDING_CURVE_CONFIG
    );

    const priceImpact =
      ((this.currentPrice - previousPrice) / previousPrice) * 100;

    this.priceHistory.push(this.currentPrice);
    this.tradeHistory.push({
      tick,
      action,
      amount,
      priceImpact,
      newPrice: this.currentPrice,
    });

    return this.currentPrice;
  }

  getPrice(): number {
    return this.currentPrice;
  }

  getNetHoldings(): number {
    return this.netHoldings;
  }

  getPriceHistory(): number[] {
    return [...this.priceHistory];
  }

  getTradeHistory() {
    return [...this.tradeHistory];
  }

  /**
   * Calculate total price change from initial
   */
  getTotalPriceChange(): number {
    return ((this.currentPrice - this.initialPrice) / this.initialPrice) * 100;
  }

  /**
   * Get max drawdown from peak
   */
  getMaxDrawdown(): number {
    let peak = this.priceHistory[0]!;
    let maxDrawdown = 0;

    for (const price of this.priceHistory) {
      if (price > peak) peak = price;
      const drawdown = ((peak - price) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return maxDrawdown;
  }

  /**
   * Get max gain from bottom
   */
  getMaxGain(): number {
    let bottom = this.priceHistory[0]!;
    let maxGain = 0;

    for (const price of this.priceHistory) {
      if (price < bottom) bottom = price;
      const gain = ((price - bottom) / bottom) * 100;
      if (gain > maxGain) maxGain = gain;
    }

    return maxGain;
  }
}

/**
 * Simulates NPC economy with balances and fee redistribution
 */
class NPCEconomySimulator {
  private balances: Map<string, number> = new Map();
  private stabilityFund: number = 0;
  private tierMinimums: Record<string, number> = {
    S_TIER: 50000,
    A_TIER: 25000,
    B_TIER: 10000,
    C_TIER: 5000,
  };

  constructor(npcs: Array<{ id: string; tier: string; balance: number }>) {
    for (const npc of npcs) {
      this.balances.set(npc.id, npc.balance);
    }
  }

  /**
   * Simulate a trade that pays fees
   */
  executeTrade(
    npcId: string,
    tradeAmount: number,
    isWinningTrade: boolean
  ): {
    newBalance: number;
    feePaid: number;
    stabilityFundContribution: number;
  } {
    const currentBalance = this.balances.get(npcId) ?? 0;

    // Calculate fee (0.1% of trade)
    const fee = tradeAmount * 0.001;
    const platformShare = fee * 0.5;
    const stabilityContribution =
      platformShare * STABILITY_FUND_CONFIG.PLATFORM_FEE_DIVERSION_RATE;

    // Update stability fund
    this.stabilityFund += stabilityContribution;

    // Calculate P&L (simplified)
    const pnl = isWinningTrade ? tradeAmount * 0.1 : -tradeAmount * 0.1;

    // Update balance
    const newBalance = currentBalance - fee + pnl;
    this.balances.set(npcId, Math.max(0, newBalance));

    return {
      newBalance: this.balances.get(npcId)!,
      feePaid: fee,
      stabilityFundContribution: stabilityContribution,
    };
  }

  /**
   * Run redistribution to top up struggling NPCs
   */
  runRedistribution(npcs: Array<{ id: string; tier: string }>): {
    npcsToppedUp: number;
    totalDistributed: number;
    fundAfter: number;
  } {
    const availableForDistribution =
      this.stabilityFund - STABILITY_FUND_CONFIG.MIN_FUND_RESERVE;

    if (availableForDistribution <= 0) {
      return {
        npcsToppedUp: 0,
        totalDistributed: 0,
        fundAfter: this.stabilityFund,
      };
    }

    let totalDistributed = 0;
    let npcsToppedUp = 0;
    const maxDistribution = Math.min(
      availableForDistribution,
      STABILITY_FUND_CONFIG.MAX_REDISTRIBUTION_PER_TICK
    );

    // Find NPCs below threshold and top them up
    for (const npc of npcs) {
      if (totalDistributed >= maxDistribution) break;
      if (npcsToppedUp >= STABILITY_FUND_CONFIG.MAX_NPCS_PER_TICK) break;

      const balance = this.balances.get(npc.id) ?? 0;
      const tierMin = this.tierMinimums[npc.tier] ?? 5000;
      const threshold = tierMin * STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO;
      const target = tierMin * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;

      if (balance < threshold) {
        const amountNeeded = Math.min(
          target - balance,
          maxDistribution - totalDistributed
        );
        this.balances.set(npc.id, balance + amountNeeded);
        totalDistributed += amountNeeded;
        npcsToppedUp++;
      }
    }

    this.stabilityFund -= totalDistributed;

    return {
      npcsToppedUp,
      totalDistributed,
      fundAfter: this.stabilityFund,
    };
  }

  getBalance(npcId: string): number {
    return this.balances.get(npcId) ?? 0;
  }

  getStabilityFund(): number {
    return this.stabilityFund;
  }

  getAllBalances(): Map<string, number> {
    return new Map(this.balances);
  }
}

describe('Market Volatility Simulation', () => {
  describe('Scenario 1: Normal Trading Day', () => {
    it('should show realistic price movements from NPC trades', () => {
      const market = new MarketSimulator(100);

      // Simulate 20 NPC trades over a "day"
      // Mix of buys and sells with varying sizes
      const trades = [
        { action: 'buy' as const, amount: 5000 },
        { action: 'buy' as const, amount: 10000 },
        { action: 'sell' as const, amount: 3000 },
        { action: 'buy' as const, amount: 15000 },
        { action: 'sell' as const, amount: 8000 },
        { action: 'buy' as const, amount: 20000 },
        { action: 'sell' as const, amount: 12000 },
        { action: 'buy' as const, amount: 5000 },
        { action: 'sell' as const, amount: 25000 },
        { action: 'buy' as const, amount: 10000 },
        { action: 'sell' as const, amount: 5000 },
        { action: 'buy' as const, amount: 8000 },
        { action: 'sell' as const, amount: 15000 },
        { action: 'buy' as const, amount: 12000 },
        { action: 'sell' as const, amount: 10000 },
        { action: 'buy' as const, amount: 5000 },
        { action: 'sell' as const, amount: 8000 },
        { action: 'buy' as const, amount: 15000 },
        { action: 'sell' as const, amount: 5000 },
        { action: 'buy' as const, amount: 10000 },
      ];

      trades.forEach((trade, i) => {
        market.trade(trade.action, trade.amount, i);
      });

      const history = market.getTradeHistory();

      // Log simulation results
      console.log('\n=== NORMAL TRADING DAY SIMULATION ===');
      console.log(`Initial Price: $${100}`);
      console.log(`Final Price: $${market.getPrice().toFixed(2)}`);
      console.log(`Total Change: ${market.getTotalPriceChange().toFixed(2)}%`);
      console.log(`Max Drawdown: ${market.getMaxDrawdown().toFixed(2)}%`);
      console.log(`Max Gain: ${market.getMaxGain().toFixed(2)}%`);
      console.log(`Net Holdings: $${market.getNetHoldings()}`);
      console.log('\nSample trades:');
      history.slice(0, 5).forEach((t) => {
        console.log(
          `  Tick ${t.tick}: ${t.action.toUpperCase()} $${t.amount} → Price $${t.newPrice.toFixed(2)} (${t.priceImpact >= 0 ? '+' : ''}${t.priceImpact.toFixed(2)}%)`
        );
      });

      // Verify price movements are meaningful but bounded
      expect(market.getPrice()).toBeGreaterThan(0);
      expect(market.getPrice()).toBeGreaterThanOrEqual(100 * 0.05); // Floor
      expect(market.getPrice()).toBeLessThanOrEqual(100 * 10); // Ceiling

      // With bonding curve, trades should have noticeable impact
      const significantMoves = history.filter(
        (t) => Math.abs(t.priceImpact) > 1
      );
      expect(significantMoves.length).toBeGreaterThan(0);
    });
  });

  describe('Scenario 2: Panic Sell Cascade', () => {
    it('should allow dramatic crash but respect floor', () => {
      const market = new MarketSimulator(100);

      console.log('\n=== PANIC SELL CASCADE SIMULATION ===');
      console.log('Simulating all NPCs panic selling...\n');

      // Simulate panic: 10 large consecutive sells
      for (let i = 0; i < 10; i++) {
        const sellAmount = 30000 + i * 5000; // Increasing panic
        market.trade('sell', sellAmount, i);
        console.log(
          `Tick ${i}: PANIC SELL $${sellAmount} → $${market.getPrice().toFixed(2)} (${market.getTotalPriceChange().toFixed(1)}%)`
        );
      }

      console.log(`\nFinal Price: $${market.getPrice().toFixed(2)}`);
      console.log(`Total Crash: ${market.getTotalPriceChange().toFixed(2)}%`);
      console.log(`Max Drawdown: ${market.getMaxDrawdown().toFixed(2)}%`);

      // Price should crash significantly but not below floor
      expect(market.getPrice()).toBeLessThan(100); // Price dropped
      expect(market.getPrice()).toBeGreaterThanOrEqual(5); // 5% floor
      expect(market.getTotalPriceChange()).toBeLessThan(0); // Negative change
    });
  });

  describe('Scenario 3: FOMO Pump', () => {
    it('should allow dramatic pump but respect ceiling', () => {
      const market = new MarketSimulator(100);

      console.log('\n=== FOMO PUMP SIMULATION ===');
      console.log('Simulating all NPCs FOMO buying...\n');

      // Simulate FOMO: 10 large consecutive buys
      for (let i = 0; i < 10; i++) {
        const buyAmount = 40000 + i * 10000; // Increasing FOMO
        market.trade('buy', buyAmount, i);
        console.log(
          `Tick ${i}: FOMO BUY $${buyAmount} → $${market.getPrice().toFixed(2)} (+${market.getTotalPriceChange().toFixed(1)}%)`
        );
      }

      console.log(`\nFinal Price: $${market.getPrice().toFixed(2)}`);
      console.log(`Total Pump: +${market.getTotalPriceChange().toFixed(2)}%`);
      console.log(`Max Gain: +${market.getMaxGain().toFixed(2)}%`);

      // Price should pump significantly but not above ceiling
      expect(market.getPrice()).toBeGreaterThan(100); // Price increased
      expect(market.getPrice()).toBeLessThanOrEqual(1000); // 10x ceiling
      expect(market.getTotalPriceChange()).toBeGreaterThan(0); // Positive change
    });
  });

  describe('Scenario 4: Max Position Size Impact', () => {
    it('should show meaningful impact from max NPC trade ($50k)', () => {
      const market = new MarketSimulator(100);

      // Single max NPC trade
      market.trade('buy', 50000, 0);

      const impact = market.getTotalPriceChange();

      console.log('\n=== MAX NPC TRADE IMPACT ===');
      console.log(`Trade Size: $50,000 (max NPC position)`);
      console.log(`Price Impact: +${impact.toFixed(2)}%`);
      console.log(`New Price: $${market.getPrice().toFixed(2)}`);

      // $50k trade should have significant impact (>5%)
      expect(impact).toBeGreaterThan(5);
      // But not exceed 30% max change per trade
      expect(impact).toBeLessThanOrEqual(30);
    });
  });

  describe('Scenario 5: Fee Redistribution Economy', () => {
    it('should prevent NPCs from going bankrupt', () => {
      const cTierThreshold =
        5000 * STABILITY_FUND_CONFIG.TOP_UP_THRESHOLD_RATIO;
      const cTierTarget = 5000 * STABILITY_FUND_CONFIG.TOP_UP_TARGET_RATIO;
      const npcs = [
        { id: 'npc-1', tier: 'S_TIER', balance: 100000 },
        { id: 'npc-2', tier: 'A_TIER', balance: 50000 },
        { id: 'npc-3', tier: 'B_TIER', balance: 15000 },
        { id: 'npc-4', tier: 'C_TIER', balance: cTierThreshold - 100 },
        { id: 'npc-5', tier: 'C_TIER', balance: cTierThreshold - 700 },
      ];

      const economy = new NPCEconomySimulator(npcs);

      console.log('\n=== FEE REDISTRIBUTION SIMULATION ===');
      console.log('Initial balances:');
      npcs.forEach((npc) => {
        console.log(`  ${npc.id} (${npc.tier}): $${npc.balance}`);
      });

      // Simulate 100 trades generating fees
      console.log('\nSimulating 100 trades...');
      let totalFees = 0;
      for (let i = 0; i < 100; i++) {
        const npcId = npcs[i % 3]!.id;
        const isWin = i % 2 === 0;
        const result = economy.executeTrade(npcId, 10000, isWin);
        totalFees += result.feePaid;
      }

      console.log(`Total fees collected: $${totalFees.toFixed(2)}`);
      console.log(
        `Stability fund before redistribution: $${economy.getStabilityFund().toFixed(2)}`
      );

      // Add more to stability fund to simulate accumulation
      // (In real game, this would accumulate over many ticks)
      const additionalFunds = 20000;
      economy['stabilityFund'] += additionalFunds;

      console.log(
        `Stability fund after accumulation: $${economy.getStabilityFund().toFixed(2)}`
      );

      // Run redistribution
      const result = economy.runRedistribution(npcs);

      console.log('\nRedistribution results:');
      console.log(`  NPCs topped up: ${result.npcsToppedUp}`);
      console.log(
        `  Total distributed: $${result.totalDistributed.toFixed(2)}`
      );
      console.log(`  Fund remaining: $${result.fundAfter.toFixed(2)}`);

      console.log('\nFinal balances:');
      npcs.forEach((npc) => {
        const balance = economy.getBalance(npc.id);
        console.log(`  ${npc.id} (${npc.tier}): $${balance.toFixed(2)}`);
      });

      // NPC-4 and NPC-5 should have been topped up
      expect(economy.getBalance('npc-4')).toBe(cTierTarget);
      expect(economy.getBalance('npc-5')).toBe(cTierTarget);

      // No NPC should be at zero
      npcs.forEach((npc) => {
        expect(economy.getBalance(npc.id)).toBeGreaterThan(0);
      });
    });
  });

  describe('Scenario 6: Momentum-Based Trading', () => {
    it('should show how herd vs contrarian NPCs trade differently', () => {
      console.log('\n=== MOMENTUM-BASED TRADING SIMULATION ===');

      // Simulate a market in panic (-15% change)
      const panicMomentum = {
        ticker: 'NVDAI',
        organizationId: 'nvidai',
        priceChange1h: -0.15,
        priceChangePercent: -15,
        currentPrice: 85,
        previousPrice: 100,
        signal: 'panic' as const,
        strength: 0.5,
      };

      console.log('\nMarket conditions: NVDAI -15% (PANIC)\n');

      // Test different NPC types
      const npcTypes: Array<{
        name: string;
        type: 'herd' | 'contrarian' | 'balanced';
      }> = [
        { name: 'FOMO Frank (herd)', type: 'herd' },
        { name: 'Value Victor (contrarian)', type: 'contrarian' },
        { name: 'Normal Nancy (balanced)', type: 'balanced' },
      ];

      npcTypes.forEach((npc) => {
        const buyMultiplier = MarketMomentumService.getTradingMultiplier(
          panicMomentum,
          npc.type,
          'buy'
        );
        const sellMultiplier = MarketMomentumService.getTradingMultiplier(
          panicMomentum,
          npc.type,
          'sell'
        );

        console.log(`${npc.name}:`);
        console.log(
          `  BUY multiplier: ${buyMultiplier.multiplier.toFixed(2)}x (${buyMultiplier.reason})`
        );
        console.log(
          `  SELL multiplier: ${sellMultiplier.multiplier.toFixed(2)}x (${sellMultiplier.reason})`
        );
        console.log('');
      });

      // Verify expected behaviors
      const herdSell = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        'herd',
        'sell'
      );
      const contrarianBuy = MarketMomentumService.getTradingMultiplier(
        panicMomentum,
        'contrarian',
        'buy'
      );

      // Herd should panic sell more
      expect(herdSell.multiplier).toBeGreaterThan(1);
      // Contrarians should buy the dip
      expect(contrarianBuy.multiplier).toBeGreaterThan(1);
    });
  });

  describe('Scenario 7: Full Day Simulation', () => {
    it('should show a realistic day of market activity', () => {
      const market = new MarketSimulator(100);

      console.log('\n=== FULL DAY MARKET SIMULATION ===');
      console.log('60 ticks (1 per minute for an hour)\n');

      // Generate realistic trading pattern
      // Morning: gradual buying
      // Midday: volatility
      // Afternoon: sell-off
      // Evening: recovery

      const phases = [
        { name: 'Morning (buying)', bias: 0.7, ticks: 15 },
        { name: 'Midday (volatile)', bias: 0.5, ticks: 15 },
        { name: 'Afternoon (selling)', bias: 0.3, ticks: 15 },
        { name: 'Evening (recovery)', bias: 0.6, ticks: 15 },
      ];

      let tickCount = 0;
      const phaseResults: Array<{
        phase: string;
        startPrice: number;
        endPrice: number;
        change: number;
      }> = [];

      for (const phase of phases) {
        const startPrice = market.getPrice();

        for (let i = 0; i < phase.ticks; i++) {
          const isBuy = Math.random() < phase.bias;
          const amount = 5000 + Math.random() * 25000; // $5k-$30k trades
          market.trade(isBuy ? 'buy' : 'sell', amount, tickCount++);
        }

        const endPrice = market.getPrice();
        const change = ((endPrice - startPrice) / startPrice) * 100;

        phaseResults.push({
          phase: phase.name,
          startPrice,
          endPrice,
          change,
        });
      }

      // Print results
      console.log('Phase Results:');
      console.log('─'.repeat(60));
      phaseResults.forEach((r) => {
        const arrow = r.change >= 0 ? '↑' : '↓';
        console.log(
          `${r.phase.padEnd(25)} $${r.startPrice.toFixed(2)} → $${r.endPrice.toFixed(2)} (${arrow}${Math.abs(r.change).toFixed(1)}%)`
        );
      });
      console.log('─'.repeat(60));
      console.log(
        `TOTAL: $100.00 → $${market.getPrice().toFixed(2)} (${market.getTotalPriceChange() >= 0 ? '+' : ''}${market.getTotalPriceChange().toFixed(1)}%)`
      );
      console.log(`Max Drawdown: ${market.getMaxDrawdown().toFixed(1)}%`);
      console.log(`Max Gain: ${market.getMaxGain().toFixed(1)}%`);

      // Verify the market moved meaningfully
      expect(market.getTradeHistory().length).toBe(60);
      // At least some volatility occurred
      expect(market.getMaxDrawdown() > 5 || market.getMaxGain() > 5).toBe(true);
    });
  });

  describe('Bonding Curve Math Verification', () => {
    it('should verify quadratic formula produces expected results', () => {
      console.log('\n=== BONDING CURVE MATH VERIFICATION ===\n');

      const testCases = [
        { holdings: 0, expected: 100 },
        { holdings: 50000, expected: 225 }, // (1 + 0.5)^2 = 2.25
        { holdings: 100000, expected: 400 }, // (1 + 1)^2 = 4
        { holdings: -50000, expected: 25 }, // (1 - 0.5)^2 = 0.25
      ];

      testCases.forEach((tc) => {
        const price = calculateBondingCurvePrice(100, tc.holdings, {
          EXPONENT: 2,
          RESERVE_DEPTH: 100000,
          USE_BONDING_CURVE: true,
        });
        console.log(
          `Holdings: $${tc.holdings.toLocaleString().padStart(10)} → Price: $${price.toFixed(2).padStart(8)} (expected: $${tc.expected})`
        );
        expect(price).toBeCloseTo(tc.expected, 0);
      });
    });
  });
});
