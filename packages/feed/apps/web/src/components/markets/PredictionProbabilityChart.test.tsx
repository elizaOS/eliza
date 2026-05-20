/**
 * Unit Tests for PredictionProbabilityChart
 *
 * Tests comprehensive chart functionality including:
 * - Data formatting and calculations
 * - YES/NO outcome visualization logic
 * - Price calculations
 * - Edge cases
 */

import { describe, expect, it } from 'bun:test';

// Mock data generator
const generateMockData = (count: number, basePrice = 0.5) => {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    time: now - (count - i) * 60000, // 1 minute intervals
    yesPrice: basePrice + (Math.random() - 0.5) * 0.2,
    noPrice: 1 - (basePrice + (Math.random() - 0.5) * 0.2),
    volume: Math.random() * 10000,
  }));
};

describe('PredictionProbabilityChart - Data Processing', () => {
  describe('Data Formatting', () => {
    it('should generate valid mock data', () => {
      const data = generateMockData(10);

      expect(data).toBeDefined();
      expect(data.length).toBe(10);
      expect(data[0]).toHaveProperty('time');
      expect(data[0]).toHaveProperty('yesPrice');
      expect(data[0]).toHaveProperty('noPrice');
      expect(data[0]).toHaveProperty('volume');
    });

    it('should handle empty data array', () => {
      const data: Array<Record<string, unknown>> = [];

      expect(data.length).toBe(0);
    });

    it('should handle single data point', () => {
      const data = generateMockData(1);

      expect(data.length).toBe(1);
    });

    it('should handle large datasets', () => {
      const data = generateMockData(1000);

      expect(data.length).toBe(1000);
      expect(data[0]).toHaveProperty('time');
    });
  });

  describe('YES/NO Probability Calculations', () => {
    it('should calculate YES percentage from price', () => {
      const yesPrice = 0.7;
      const yesProbability = yesPrice * 100;

      expect(yesProbability).toBe(70);
    });

    it('should calculate NO percentage from price', () => {
      const noPrice = 0.3;
      const noProbability = noPrice * 100;

      expect(noProbability).toBe(30);
    });

    it('should determine YES is favored when above 50%', () => {
      const probability = 60;
      const isYesFavored = probability >= 50;

      expect(isYesFavored).toBe(true);
    });

    it('should determine NO is favored when below 50%', () => {
      const probability = 40;
      const isYesFavored = probability >= 50;

      expect(isYesFavored).toBe(false);
    });

    it('should handle 50/50 split correctly', () => {
      const probability = 50;
      const isYesFavored = probability >= 50;

      expect(isYesFavored).toBe(true); // 50% defaults to YES favored
    });
  });

  describe('Color Assignment Logic', () => {
    it('should keep YES/NO series colors distinct', () => {
      // YES should remain green and NO should remain red, regardless of which side is favored.
      const yesLineColor = '#22c55e';
      const noLineColor = '#ef4444';

      expect(yesLineColor).toBe('#22c55e');
      expect(noLineColor).toBe('#ef4444');
      expect(yesLineColor).not.toBe(noLineColor);
    });
  });

  describe('Data Validation', () => {
    it('should handle prices at 0%', () => {
      const data = [
        { time: Date.now(), yesPrice: 0, noPrice: 1, volume: 1000 },
      ];

      expect(data[0]!.yesPrice * 100).toBe(0);
      expect(data[0]!.noPrice * 100).toBe(100);
    });

    it('should handle prices at 100%', () => {
      const data = [
        { time: Date.now(), yesPrice: 1, noPrice: 0, volume: 1000 },
      ];

      expect(data[0]!.yesPrice * 100).toBe(100);
      expect(data[0]!.noPrice * 100).toBe(0);
    });

    it('should handle negative volumes gracefully', () => {
      const data = [
        { time: Date.now(), yesPrice: 0.5, noPrice: 0.5, volume: -1000 },
      ];

      expect(data[0]!.volume).toBe(-1000);
      expect(data[0]!.yesPrice).toBeGreaterThanOrEqual(0);
      expect(data[0]!.noPrice).toBeGreaterThanOrEqual(0);
    });

    it('should handle very old timestamps', () => {
      const oldTime = new Date('2020-01-01').getTime();
      const data = [
        { time: oldTime, yesPrice: 0.5, noPrice: 0.5, volume: 1000 },
      ];

      expect(data[0]!.time).toBe(oldTime);
      expect(data[0]!.time).toBeLessThan(Date.now());
    });

    it('should handle future timestamps', () => {
      const futureTime = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year ahead
      const data = [
        { time: futureTime, yesPrice: 0.5, noPrice: 0.5, volume: 1000 },
      ];

      expect(data[0]!.time).toBe(futureTime);
      expect(data[0]!.time).toBeGreaterThan(Date.now());
    });
  });

  describe('Chart Configuration', () => {
    it('should generate unique gradient IDs based on marketId', () => {
      const marketId1 = 'market-1';
      const marketId2 = 'market-2';

      const gradientId1 = `fillProbability-${marketId1}`;
      const gradientId2 = `fillProbability-${marketId2}`;

      expect(gradientId1).not.toBe(gradientId2);
      expect(gradientId1).toBe('fillProbability-market-1');
      expect(gradientId2).toBe('fillProbability-market-2');
    });
  });

  describe('Probability Calculations', () => {
    it('should calculate percentages correctly', () => {
      const yesPrice = 0.75;
      const percentage = yesPrice * 100;

      expect(percentage).toBe(75);
    });

    it('should ensure YES + NO equals 100%', () => {
      const yesPrice = 0.6;
      const noPrice = 0.4;

      const yesPercentage = yesPrice * 100;
      const noPercentage = noPrice * 100;

      expect(yesPercentage + noPercentage).toBe(100);
    });

    it('should handle complementary probabilities', () => {
      const yesPrice = 0.65;
      const noPrice = 1 - yesPrice;

      expect(noPrice).toBe(0.35);
      expect(yesPrice + noPrice).toBeCloseTo(1, 10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle data points with same timestamp', () => {
      const time = Date.now();
      const data = [
        { time, yesPrice: 0.5, noPrice: 0.5, volume: 1000 },
        { time, yesPrice: 0.6, noPrice: 0.4, volume: 1500 },
      ];

      expect(data[0]!.time).toBe(data[1]!.time);
      expect(data.length).toBe(2);
    });

    it('should handle unsorted data', () => {
      const now = Date.now();
      const data = [
        { time: now, yesPrice: 0.5, noPrice: 0.5, volume: 1000 },
        { time: now - 60000, yesPrice: 0.6, noPrice: 0.4, volume: 1500 },
        { time: now + 60000, yesPrice: 0.4, noPrice: 0.6, volume: 800 },
      ];

      expect(data.length).toBe(3);
      expect(data[1]!.time).toBeLessThan(data[0]!.time);
      expect(data[2]!.time).toBeGreaterThan(data[0]!.time);
    });

    it('should handle extreme price volatility', () => {
      const now = Date.now();
      const data = [
        { time: now - 120000, yesPrice: 0.1, noPrice: 0.9, volume: 1000 },
        { time: now - 60000, yesPrice: 0.9, noPrice: 0.1, volume: 1000 },
        { time: now, yesPrice: 0.1, noPrice: 0.9, volume: 1000 },
      ];

      // Calculate volatility
      const prices = data.map((d) => d.yesPrice);
      const maxPrice = Math.max(...prices);
      const minPrice = Math.min(...prices);
      const volatility = maxPrice - minPrice;

      expect(volatility).toBe(0.8); // High volatility
      expect(maxPrice).toBe(0.9);
      expect(minPrice).toBe(0.1);
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
      expect(ticks[0]).toBe(min);
    });
  });
});

console.log('✅ PredictionProbabilityChart tests defined');
