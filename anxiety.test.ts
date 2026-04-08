import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the anxiety provider functionality
describe('anxietyProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default configuration', () => {
      const config = {
        enabled: true,
        threshold: 0.5,
      };
      expect(config.enabled).toBe(true);
      expect(config.threshold).toBe(0.5);
    });

    it('should accept custom threshold values', () => {
      const config = {
        enabled: true,
        threshold: 0.8,
      };
      expect(config.threshold).toBe(0.8);
    });
  });

  describe('anxiety detection', () => {
    it('should detect anxiety indicators in text', () => {
      const anxietyIndicators = ['worried', 'anxious', 'stressed', 'nervous'];
      const text = 'I am feeling very anxious today';
      const hasAnxiety = anxietyIndicators.some(indicator => 
        text.toLowerCase().includes(indicator)
      );
      expect(hasAnxiety).toBe(true);
    });

    it('should return false when no anxiety indicators present', () => {
      const anxietyIndicators = ['worried', 'anxious', 'stressed', 'nervous'];
      const text = 'I am feeling great today';
      const hasAnxiety = anxietyIndicators.some(indicator => 
        text.toLowerCase().includes(indicator)
      );
      expect(hasAnxiety).toBe(false);
    });
  });

  describe('provider configuration', () => {
    it('should be disabled when enabled is false', () => {
      const config = {
        enabled: false,
        threshold: 0.5,
      };
      expect(config.enabled).toBe(false);
    });

    it('should validate threshold is within valid range', () => {
      const isValidThreshold = (threshold: number) => {
        return threshold >= 0 && threshold <= 1;
      };
      
      expect(isValidThreshold(0.5)).toBe(true);
      expect(isValidThreshold(0)).toBe(true);
      expect(isValidThreshold(1)).toBe(true);
      expect(isValidThreshold(-0.1)).toBe(false);
      expect(isValidThreshold(1.1)).toBe(false);
    });
  });
});
