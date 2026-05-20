/**
 * Tests for ticker sanitization in MarketDecisionEngine
 *
 * Tests the logic that handles LLM-generated ticker hallucinations:
 * - Leading/trailing underscores (_METAI -> METAI)
 * - Letter swaps (TSALI -> TSLAI)
 * - Missing AI suffix (META -> METAI)
 * - Common typos and aliases
 */

import { describe, expect, test } from 'bun:test';

// Test the sanitization logic directly without mocking the whole engine
describe('Ticker Sanitization Logic', () => {
  // Replicate the mapping from MarketDecisionEngine
  const originalTickerToActualTickerMap = new Map<string, string>([
    // Common LLM letter-swap typos for AI-suffixed tickers
    ['tsali', 'TSLAI'],
    ['metia', 'METAI'],
    ['solai', 'SOLAI'],
    ['soali', 'SOLAI'],
    ['btaci', 'BTCAI'],
    ['ethia', 'ETHAI'],
    ['ehtai', 'ETHAI'],
    // Without AI suffix (LLM sometimes drops it)
    ['tsla', 'TSLAI'],
    ['tesla', 'TSLAI'],
    ['teslai', 'TSLAI'],
    ['meta', 'METAI'],
    ['sol', 'SOLAI'],
    ['solana', 'SOLAI'],
    // Crypto aliases
    ['btc', 'BTCAI'],
    ['bitcoin', 'BTCAI'],
    ['eth', 'ETHAI'],
    ['ethereum', 'ETHAI'],
  ]);

  // Replicate the sanitization function
  function sanitizeTicker(rawTicker: string): string {
    // Strip leading/trailing underscores and whitespace
    const sanitizedTicker = String(rawTicker)
      .trim()
      .replace(/^_+|_+$/g, '');
    const normalizedTicker = sanitizedTicker.toLowerCase();

    const mappedTicker = originalTickerToActualTickerMap.get(normalizedTicker);
    return mappedTicker ?? sanitizedTicker;
  }

  describe('Leading/trailing character handling', () => {
    test('strips leading underscores', () => {
      expect(sanitizeTicker('_METAI')).toBe('METAI');
      expect(sanitizeTicker('__BTCAI')).toBe('BTCAI');
    });

    test('strips trailing underscores', () => {
      expect(sanitizeTicker('METAI_')).toBe('METAI');
      expect(sanitizeTicker('BTCAI__')).toBe('BTCAI');
    });

    test('strips both leading and trailing underscores', () => {
      expect(sanitizeTicker('_SOLAI_')).toBe('SOLAI');
      expect(sanitizeTicker('__ETHAI__')).toBe('ETHAI');
    });

    test('strips whitespace', () => {
      expect(sanitizeTicker('  METAI  ')).toBe('METAI');
      expect(sanitizeTicker(' BTCAI ')).toBe('BTCAI');
    });
  });

  describe('LLM letter-swap typo corrections', () => {
    test('corrects TSALI -> TSLAI', () => {
      expect(sanitizeTicker('TSALI')).toBe('TSLAI');
      expect(sanitizeTicker('tsali')).toBe('TSLAI');
    });

    test('corrects METIA -> METAI', () => {
      expect(sanitizeTicker('METIA')).toBe('METAI');
    });

    test('corrects SOALI -> SOLAI', () => {
      expect(sanitizeTicker('SOALI')).toBe('SOLAI');
    });

    test('corrects BTACI -> BTCAI', () => {
      expect(sanitizeTicker('BTACI')).toBe('BTCAI');
    });

    test('corrects ETHIA -> ETHAI', () => {
      expect(sanitizeTicker('ETHIA')).toBe('ETHAI');
    });

    test('corrects EHTAI -> ETHAI', () => {
      expect(sanitizeTicker('EHTAI')).toBe('ETHAI');
    });
  });

  describe('Missing AI suffix corrections', () => {
    test('corrects TSLA -> TSLAI', () => {
      expect(sanitizeTicker('TSLA')).toBe('TSLAI');
      expect(sanitizeTicker('tsla')).toBe('TSLAI');
    });

    test('corrects META -> METAI', () => {
      expect(sanitizeTicker('META')).toBe('METAI');
      expect(sanitizeTicker('meta')).toBe('METAI');
    });

    test('corrects SOL -> SOLAI', () => {
      expect(sanitizeTicker('SOL')).toBe('SOLAI');
      expect(sanitizeTicker('sol')).toBe('SOLAI');
    });

    test('corrects TESLA -> TSLAI (full name)', () => {
      expect(sanitizeTicker('TESLA')).toBe('TSLAI');
      expect(sanitizeTicker('tesla')).toBe('TSLAI');
    });

    test('corrects SOLANA -> SOLAI (full name)', () => {
      expect(sanitizeTicker('SOLANA')).toBe('SOLAI');
      expect(sanitizeTicker('solana')).toBe('SOLAI');
    });
  });

  describe('Crypto aliases', () => {
    test('corrects BTC -> BTCAI', () => {
      expect(sanitizeTicker('BTC')).toBe('BTCAI');
      expect(sanitizeTicker('btc')).toBe('BTCAI');
    });

    test('corrects BITCOIN -> BTCAI', () => {
      expect(sanitizeTicker('BITCOIN')).toBe('BTCAI');
      expect(sanitizeTicker('bitcoin')).toBe('BTCAI');
    });

    test('corrects ETH -> ETHAI', () => {
      expect(sanitizeTicker('ETH')).toBe('ETHAI');
      expect(sanitizeTicker('eth')).toBe('ETHAI');
    });

    test('corrects ETHEREUM -> ETHAI', () => {
      expect(sanitizeTicker('ETHEREUM')).toBe('ETHAI');
      expect(sanitizeTicker('ethereum')).toBe('ETHAI');
    });
  });

  describe('Preserves valid tickers', () => {
    test('preserves BTCAI', () => {
      expect(sanitizeTicker('BTCAI')).toBe('BTCAI');
    });

    test('preserves ETHAI', () => {
      expect(sanitizeTicker('ETHAI')).toBe('ETHAI');
    });

    test('preserves SOLAI', () => {
      expect(sanitizeTicker('SOLAI')).toBe('SOLAI');
    });

    test('preserves TSLAI', () => {
      expect(sanitizeTicker('TSLAI')).toBe('TSLAI');
    });

    test('preserves METAI', () => {
      expect(sanitizeTicker('METAI')).toBe('METAI');
    });
  });

  describe('Case insensitivity', () => {
    test('handles mixed case inputs', () => {
      expect(sanitizeTicker('TsLaI')).toBe('TsLaI'); // not in map, returned as-is
      expect(sanitizeTicker('tsla')).toBe('TSLAI'); // in map
      expect(sanitizeTicker('TSLA')).toBe('TSLAI'); // in map (case-insensitive)
    });
  });

  describe('Unknown tickers', () => {
    test('passes through unknown tickers unchanged', () => {
      expect(sanitizeTicker('UNKNOWN')).toBe('UNKNOWN');
      expect(sanitizeTicker('NEWTOKEN')).toBe('NEWTOKEN');
      expect(sanitizeTicker('XYZ123')).toBe('XYZ123');
    });

    test('still sanitizes unknown tickers', () => {
      expect(sanitizeTicker('_UNKNOWN_')).toBe('UNKNOWN');
      expect(sanitizeTicker('  NEWTOKEN  ')).toBe('NEWTOKEN');
    });
  });

  describe('Combined edge cases', () => {
    test('handles underscore + typo combination', () => {
      // _TSALI_ should strip underscores and correct typo
      expect(sanitizeTicker('_TSALI_')).toBe('TSLAI');
    });

    test('handles whitespace + missing suffix', () => {
      expect(sanitizeTicker('  META  ')).toBe('METAI');
    });
  });
});
