import { describe, it, expect } from 'bun:test';
import { LoreService } from '../services/lore-service';

describe('LoreService', () => {
  describe('service metadata', () => {
    it('should have correct service type', () => {
      expect(LoreService.serviceType).toBe('lore' as any);
    });

    it('should have capability description', () => {
      const service = new LoreService();
      expect(service.capabilityDescription).toContain('Character-specific lore management');
    });
  });

  describe('embedding dimension detection', () => {
    it('should support 384-dimensional embeddings', () => {
      const { LORE_DIMENSION_MAP } = require('../types');
      expect(LORE_DIMENSION_MAP[384]).toBe('dim_384');
    });

    it('should support 768-dimensional embeddings', () => {
      const { LORE_DIMENSION_MAP } = require('../types');
      expect(LORE_DIMENSION_MAP[768]).toBe('dim_768');
    });

    it('should support 1536-dimensional embeddings', () => {
      const { LORE_DIMENSION_MAP } = require('../types');
      expect(LORE_DIMENSION_MAP[1536]).toBe('dim_1536');
    });

    it('should support all standard dimensions', () => {
      const { LORE_DIMENSION_MAP } = require('../types');
      const supportedDimensions = Object.keys(LORE_DIMENSION_MAP).map(Number);

      expect(supportedDimensions).toContain(384);
      expect(supportedDimensions).toContain(512);
      expect(supportedDimensions).toContain(768);
      expect(supportedDimensions).toContain(1024);
      expect(supportedDimensions).toContain(1536);
      expect(supportedDimensions).toContain(3072);
    });
  });
});
