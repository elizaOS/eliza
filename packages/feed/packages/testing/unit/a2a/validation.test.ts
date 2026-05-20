/**
 * A2A Validation Schema Unit Tests
 *
 * Tests for Zod validation schemas used in A2A protocol
 */

import { describe, expect, it } from 'bun:test';
import {
  BuySharesParamsSchema,
  CreatePostParamsSchema,
  DiscoverParamsSchema,
  GetFeedParamsSchema,
  OpenPositionParamsSchema,
  PaymentRequestParamsSchema,
  SearchUsersParamsSchema,
} from '@feed/a2a';

describe('A2A Validation Schemas', () => {
  describe('DiscoverParamsSchema', () => {
    it('should accept valid discover params', () => {
      const result = DiscoverParamsSchema.safeParse({
        filters: {
          strategies: ['trading', 'analysis'],
          minReputation: 100,
          markets: ['prediction'],
        },
        limit: 10,
      });

      expect(result.success).toBe(true);
    });

    it('should accept empty params', () => {
      const result = DiscoverParamsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept partial filters', () => {
      const result = DiscoverParamsSchema.safeParse({
        filters: {
          strategies: ['trading'],
        },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('PaymentRequestParamsSchema', () => {
    it('should accept valid payment request', () => {
      const result = PaymentRequestParamsSchema.safeParse({
        to: '0x1234567890abcdef',
        amount: '1000000000000000000',
        service: 'market_analysis',
      });

      expect(result.success).toBe(true);
    });

    it('should accept payment with metadata', () => {
      const result = PaymentRequestParamsSchema.safeParse({
        to: '0x1234567890abcdef',
        amount: '1000000000000000000',
        service: 'market_analysis',
        metadata: {
          requestId: '123',
          marketId: 'market-001',
        },
        from: '0xabcdef1234567890',
      });

      expect(result.success).toBe(true);
    });

    it('should reject missing required fields', () => {
      const result = PaymentRequestParamsSchema.safeParse({
        to: '0x1234567890abcdef',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('BuySharesParamsSchema', () => {
    it('should accept valid buy shares params', () => {
      const result = BuySharesParamsSchema.safeParse({
        marketId: 'market-001',
        outcome: 'YES',
        amount: 100,
      });

      expect(result.success).toBe(true);
    });

    it('should accept NO outcome', () => {
      const result = BuySharesParamsSchema.safeParse({
        marketId: 'market-001',
        outcome: 'NO',
        amount: 50,
      });

      expect(result.success).toBe(true);
    });

    it('should reject invalid outcome', () => {
      const result = BuySharesParamsSchema.safeParse({
        marketId: 'market-001',
        outcome: 'MAYBE',
        amount: 100,
      });

      expect(result.success).toBe(false);
    });

    it('should reject non-positive amount', () => {
      const result = BuySharesParamsSchema.safeParse({
        marketId: 'market-001',
        outcome: 'YES',
        amount: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative amount', () => {
      const result = BuySharesParamsSchema.safeParse({
        marketId: 'market-001',
        outcome: 'YES',
        amount: -10,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('OpenPositionParamsSchema', () => {
    it('should accept valid long position', () => {
      const result = OpenPositionParamsSchema.safeParse({
        ticker: 'BTC',
        side: 'LONG',
        amount: 1000,
        leverage: 10,
      });

      expect(result.success).toBe(true);
    });

    it('should accept valid short position', () => {
      const result = OpenPositionParamsSchema.safeParse({
        ticker: 'ETH',
        side: 'SHORT',
        amount: 500,
        leverage: 5,
      });

      expect(result.success).toBe(true);
    });

    it('should reject leverage below 1', () => {
      const result = OpenPositionParamsSchema.safeParse({
        ticker: 'BTC',
        side: 'LONG',
        amount: 1000,
        leverage: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject leverage above 100', () => {
      const result = OpenPositionParamsSchema.safeParse({
        ticker: 'BTC',
        side: 'LONG',
        amount: 1000,
        leverage: 101,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('CreatePostParamsSchema', () => {
    it('should accept valid post', () => {
      const result = CreatePostParamsSchema.safeParse({
        content: 'This is a test post',
      });

      expect(result.success).toBe(true);
    });

    it('should accept post with type', () => {
      const result = CreatePostParamsSchema.safeParse({
        content: 'This is an article',
        type: 'article',
      });

      expect(result.success).toBe(true);
    });

    it('should reject empty content', () => {
      const result = CreatePostParamsSchema.safeParse({
        content: '',
      });

      expect(result.success).toBe(false);
    });

    it('should reject content exceeding max length', () => {
      const result = CreatePostParamsSchema.safeParse({
        content: 'a'.repeat(5001),
      });

      expect(result.success).toBe(false);
    });

    it('should default type to post', () => {
      const result = CreatePostParamsSchema.safeParse({
        content: 'Test post',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('post');
      }
    });
  });

  describe('GetFeedParamsSchema', () => {
    it('should accept empty params with defaults', () => {
      const result = GetFeedParamsSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('should accept custom pagination', () => {
      const result = GetFeedParamsSchema.safeParse({
        limit: 50,
        offset: 100,
      });

      expect(result.success).toBe(true);
    });

    it('should accept following filter', () => {
      const result = GetFeedParamsSchema.safeParse({
        following: true,
      });

      expect(result.success).toBe(true);
    });

    it('should accept type filter', () => {
      const result = GetFeedParamsSchema.safeParse({
        type: 'article',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('SearchUsersParamsSchema', () => {
    it('should accept valid search query', () => {
      const result = SearchUsersParamsSchema.safeParse({
        query: 'trader',
      });

      expect(result.success).toBe(true);
    });

    it('should accept search with limit', () => {
      const result = SearchUsersParamsSchema.safeParse({
        query: 'analyst',
        limit: 10,
      });

      expect(result.success).toBe(true);
    });

    it('should reject empty query', () => {
      const result = SearchUsersParamsSchema.safeParse({
        query: '',
      });

      expect(result.success).toBe(false);
    });

    it('should use default limit', () => {
      const result = SearchUsersParamsSchema.safeParse({
        query: 'test',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
      }
    });
  });
});
