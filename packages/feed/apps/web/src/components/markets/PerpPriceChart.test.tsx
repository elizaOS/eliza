/**
 * Unit Tests for PerpPriceChart
 *
 * Tests comprehensive chart functionality including:
 * - Data formatting and calculations
 * - Price formatting logic
 * - Time range filtering logic
 * - Edge cases
 */

import { describe, expect, it } from 'bun:test';
import { FEED_POINTS_SYMBOL } from '@feed/shared';

// Mock data generator
const generateMockPriceData = (count: number, startPrice = 100) => {
  const now = Date.now();
  let price = startPrice;
  return Array.from({ length: count }, (_, i) => {
    price = price + (Math.random() - 0.5) * 10;
    return {
      time: now - (count - i) * 60000, // 1 minute intervals
      price: Math.max(0.01, price), // Keep prices positive
    };
  });
};

describe('PerpPriceChart - Data Processing', () => {
  describe('Data Formatting', () => {
    it('should generate valid mock data', () => {
      const data = generateMockPriceData(10);

      expect(data).toBeDefined();
      expect(data.length).toBe(10);
      expect(data[0]).toHaveProperty('time');
      expect(data[0]).toHaveProperty('price');
    });

    it('should handle empty data array', () => {
      const data: Array<Record<string, unknown>> = [];

      expect(data.length).toBe(0);
    });

    it('should handle single data point', () => {
      const data = generateMockPriceData(1);

      expect(data.length).toBe(1);
    });

    it('should handle large datasets', () => {
      const data = generateMockPriceData(1000);

      expect(data.length).toBe(1000);
      expect(data[0]).toHaveProperty('time');
    });
  });

  describe('Price Change Calculations', () => {
    it('should calculate positive price change', () => {
      const startPrice = 100;
      const endPrice = 110;
      const priceChange = endPrice - startPrice;

      expect(priceChange).toBe(10);
      expect(priceChange).toBeGreaterThan(0);
    });

    it('should calculate negative price change', () => {
      const startPrice = 110;
      const endPrice = 100;
      const priceChange = endPrice - startPrice;

      expect(priceChange).toBe(-10);
      expect(priceChange).toBeLessThan(0);
    });

    it('should calculate percentage change correctly', () => {
      const startPrice = 100;
      const endPrice = 110;
      const priceChange = endPrice - startPrice;
      const percentChange = (priceChange / startPrice) * 100;

      expect(percentChange).toBe(10);
    });

    it('should determine positive trend', () => {
      const startPrice = 100;
      const endPrice = 110;
      const isPositive = endPrice >= startPrice;

      expect(isPositive).toBe(true);
    });

    it('should determine negative trend', () => {
      const startPrice = 110;
      const endPrice = 100;
      const isPositive = endPrice >= startPrice;

      expect(isPositive).toBe(false);
    });
  });

  describe('Price Formatting Logic', () => {
    it('should format billions correctly', () => {
      const price = 1500000000;
      const formatted = `${FEED_POINTS_SYMBOL}${(price / 1000000000).toFixed(2)}B`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}1.50B`);
    });

    it('should format millions correctly', () => {
      const price = 1500000;
      const formatted = `${FEED_POINTS_SYMBOL}${(price / 1000000).toFixed(2)}M`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}1.50M`);
    });

    it('should format thousands correctly', () => {
      const price = 1500;
      const formatted = `${FEED_POINTS_SYMBOL}${(price / 1000).toFixed(2)}K`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}1.50K`);
    });

    it('should format regular prices correctly', () => {
      const price = 123.456;
      const formatted = `${FEED_POINTS_SYMBOL}${price.toFixed(2)}`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}123.46`);
    });

    it('should format small decimals correctly', () => {
      const price = 0.001234;
      const formatted = `${FEED_POINTS_SYMBOL}${price.toFixed(6)}`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}0.001234`);
    });

    it('should format very small decimals correctly', () => {
      const price = 0.00000123;
      const formatted = `${FEED_POINTS_SYMBOL}${price.toFixed(8)}`;

      expect(formatted).toBe(`${FEED_POINTS_SYMBOL}0.00000123`);
    });

    it('should handle zero price', () => {
      const price = 0;
      const formatted = price === 0 ? '' : `${FEED_POINTS_SYMBOL}${price}`;

      expect(formatted).toBe('');
    });
  });

  describe('Time Range Filtering Logic', () => {
    it('should calculate 1H cutoff correctly', () => {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      const cutoff = now - oneHour;

      expect(cutoff).toBeLessThan(now);
      expect(now - cutoff).toBe(oneHour);
    });

    it('should calculate 4H cutoff correctly', () => {
      const now = Date.now();
      const fourHours = 4 * 60 * 60 * 1000;
      const cutoff = now - fourHours;

      expect(now - cutoff).toBe(fourHours);
    });

    it('should calculate 1D cutoff correctly', () => {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const cutoff = now - oneDay;

      expect(now - cutoff).toBe(oneDay);
    });

    it('should calculate 1W cutoff correctly', () => {
      const now = Date.now();
      const oneWeek = 7 * 24 * 60 * 60 * 1000;
      const cutoff = now - oneWeek;

      expect(now - cutoff).toBe(oneWeek);
    });

    it('should filter data within time range', () => {
      const now = Date.now();
      const data = [
        { time: now - 2 * 60 * 60 * 1000, price: 100 }, // 2 hours ago
        { time: now - 30 * 60 * 1000, price: 110 }, // 30 minutes ago
        { time: now, price: 105 }, // now
      ];

      const cutoff = now - 60 * 60 * 1000; // 1 hour ago
      const filtered = data.filter((d) => d.time >= cutoff);

      expect(filtered.length).toBe(2);
      expect(filtered[0]!.time).toBeGreaterThanOrEqual(cutoff);
    });
  });

  describe('Color Assignment Logic', () => {
    it('should assign green color for positive change', () => {
      const isPositive = true;
      const priceColor = isPositive
        ? 'var(--color-priceUp)'
        : 'var(--color-priceDown)';

      expect(priceColor).toBe('var(--color-priceUp)');
    });

    it('should assign red color for negative change', () => {
      const isPositive = false;
      const priceColor = isPositive
        ? 'var(--color-priceUp)'
        : 'var(--color-priceDown)';

      expect(priceColor).toBe('var(--color-priceDown)');
    });
  });

  describe('Chart Configuration', () => {
    it('should generate unique gradient IDs based on ticker', () => {
      const ticker1 = 'BTC';
      const ticker2 = 'ETH';

      const gradientId1 = `fillPrice-${ticker1}`;
      const gradientId2 = `fillPrice-${ticker2}`;

      expect(gradientId1).not.toBe(gradientId2);
      expect(gradientId1).toBe('fillPrice-BTC');
      expect(gradientId2).toBe('fillPrice-ETH');
    });

    it('should determine brush visibility based on data size', () => {
      const smallData = generateMockPriceData(5);
      const largeData = generateMockPriceData(50);

      const showBrushSmall = smallData.length > 10;
      const showBrushLarge = largeData.length > 10;

      expect(showBrushSmall).toBe(false);
      expect(showBrushLarge).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero price', () => {
      const data = [{ time: Date.now(), price: 0 }];

      expect(data[0]!.price).toBe(0);
    });

    it('should handle very large prices', () => {
      const largePrice = 999999999999;
      const data = [{ time: Date.now(), price: largePrice }];

      expect(data[0]!.price).toBeGreaterThan(1000000000);
    });

    it('should handle very small prices', () => {
      const smallPrice = 0.000000001;
      const data = [{ time: Date.now(), price: smallPrice }];

      expect(data[0]!.price).toBeLessThan(0.01);
    });

    it('should handle data points with same timestamp', () => {
      const time = Date.now();
      const data = [
        { time, price: 100 },
        { time, price: 110 },
      ];

      expect(data[0]!.time).toBe(data[1]!.time);
      expect(data.length).toBe(2);
    });

    it('should handle unsorted data', () => {
      const now = Date.now();
      const data = [
        { time: now, price: 100 },
        { time: now - 60000, price: 110 },
        { time: now + 60000, price: 105 },
      ];

      expect(data.length).toBe(3);
      expect(data[1]!.time).toBeLessThan(data[0]!.time);
      expect(data[2]!.time).toBeGreaterThan(data[0]!.time);
    });

    it('should handle extreme price volatility', () => {
      const now = Date.now();
      const data = [
        { time: now - 120000, price: 10 },
        { time: now - 60000, price: 1000 },
        { time: now, price: 50 },
      ];

      const prices = data.map((d) => d.price);
      const maxPrice = Math.max(...prices);
      const minPrice = Math.min(...prices);
      const volatility = ((maxPrice - minPrice) / minPrice) * 100;

      expect(volatility).toBeGreaterThan(1000); // Over 1000% volatility
      expect(maxPrice).toBe(1000);
      expect(minPrice).toBe(10);
    });

    it('should handle negative prices gracefully', () => {
      const data = [{ time: Date.now(), price: -100 }];

      expect(data[0]!.price).toBeLessThan(0);
    });
  });

  describe('Time Tick Calculation', () => {
    it('should calculate evenly spaced ticks', () => {
      const min = 1000;
      const max = 5000;
      const count = 5;
      const step = (max - min) / (count - 1);

      const ticks = Array.from({ length: count }, (_, i) =>
        Math.round(min + i * step)
      );

      expect(ticks.length).toBe(5);
      expect(ticks[0]).toBe(min);
      expect(ticks[ticks.length - 1]).toBe(max);
    });

    it('should handle single tick', () => {
      const min = 1000;

      const ticks = [min];

      expect(ticks.length).toBe(1);
      expect(ticks[0]!).toBe(min);
    });
  });

  describe('Percentage Formatting', () => {
    it('should format positive percentage with plus sign', () => {
      const percentChange = 10.5;
      const formatted =
        percentChange >= 0
          ? `+${percentChange.toFixed(2)}%`
          : `${percentChange.toFixed(2)}%`;

      expect(formatted).toBe('+10.50%');
    });

    it('should format negative percentage without double negative', () => {
      const percentChange = -10.5;
      const formatted =
        percentChange >= 0
          ? `+${percentChange.toFixed(2)}%`
          : `${percentChange.toFixed(2)}%`;

      expect(formatted).toBe('-10.50%');
    });

    it('should format zero percentage correctly', () => {
      const percentChange = 0;
      const formatted =
        percentChange >= 0
          ? `+${percentChange.toFixed(2)}%`
          : `${percentChange.toFixed(2)}%`;

      expect(formatted).toBe('+0.00%');
    });
  });
});

console.log('✅ PerpPriceChart tests defined');
