/**
 * Tests for extractEventKeywords utility
 *
 * Verifies keyword extraction from event/question text:
 * - Price extraction ($94k, $100,000)
 * - Percentage extraction (+15%, -20%)
 * - Date extraction (January 15, Q1 2025)
 * - Symbol extraction (BTC, ETH)
 * - Entity extraction (Bitcoin, Tesla, etc.)
 * - Action extraction (crash, surge, launch)
 */

import { describe, expect, it } from 'vitest';

import { extractEventKeywords } from '../../services/lookahead-generation-service';

describe('extractEventKeywords', () => {
  describe('Price extraction', () => {
    it('should extract dollar amounts', () => {
      const keywords = extractEventKeywords('Bitcoin breaks $94,000');
      expect(keywords).toContain('$94000');
    });

    it('should extract K notation prices', () => {
      const keywords = extractEventKeywords('BTC hits 100k');
      expect(keywords).toContain('100k');
    });

    it('should extract multiple prices', () => {
      const keywords = extractEventKeywords(
        'Bitcoin went from $50,000 to $94,000'
      );
      expect(keywords).toContain('$50000');
      expect(keywords).toContain('$94000');
    });

    it('should normalize prices to lowercase without commas', () => {
      const keywords = extractEventKeywords('$100K target reached');
      expect(keywords).toContain('$100k');
    });
  });

  describe('Percentage extraction', () => {
    it('should extract positive percentages', () => {
      const keywords = extractEventKeywords('Stock up +15%');
      expect(keywords).toContain('+15%');
    });

    it('should extract negative percentages', () => {
      const keywords = extractEventKeywords('Market down -20%');
      expect(keywords).toContain('-20%');
    });

    it('should extract decimal percentages', () => {
      const keywords = extractEventKeywords('Gain of 3.5% today');
      expect(keywords).toContain('3.5%');
    });

    it('should extract unsigned percentages', () => {
      const keywords = extractEventKeywords('10% increase');
      expect(keywords).toContain('10%');
    });
  });

  describe('Date extraction', () => {
    it('should extract month and day', () => {
      const keywords = extractEventKeywords('Deadline is January 15');
      expect(keywords).toContain('january 15');
    });

    it('should extract quarter and year', () => {
      const keywords = extractEventKeywords('Expected in Q1 2025');
      expect(keywords).toContain('q1 2025');
    });

    it('should extract standalone years', () => {
      const keywords = extractEventKeywords('Predictions for 2025');
      expect(keywords).toContain('2025');
    });

    it('should normalize dates to lowercase', () => {
      const keywords = extractEventKeywords('DECEMBER 25 deadline');
      expect(keywords).toContain('december 25');
    });

    it('should handle multiple months', () => {
      const keywords = extractEventKeywords('From March 1 to April 15');
      expect(keywords).toContain('march 1');
      expect(keywords).toContain('april 15');
    });
  });

  describe('Symbol extraction', () => {
    it('should extract crypto symbols', () => {
      const keywords = extractEventKeywords('BTC and ETH rally continues');
      expect(keywords).toContain('BTC');
      expect(keywords).toContain('ETH');
    });

    it('should extract altcoin symbols', () => {
      const keywords = extractEventKeywords('SOL, DOGE, and XRP moving');
      expect(keywords).toContain('SOL');
      expect(keywords).toContain('DOGE');
      expect(keywords).toContain('XRP');
    });

    it('should uppercase symbols', () => {
      const keywords = extractEventKeywords('btc and eth');
      expect(keywords).toContain('BTC');
      expect(keywords).toContain('ETH');
    });

    it('should not extract partial matches', () => {
      // Should not contain ETH since ETHANOL doesn't have word boundary
      const result = extractEventKeywords('ETHANOL');
      expect(result).not.toContain('ETH');
    });
  });

  describe('Entity extraction', () => {
    // Game uses AI-stylized names to avoid copyright issues
    // Entity IDs must match canonical IDs in packages/engine/src/data/

    it('should extract crypto symbols', () => {
      const keywords = extractEventKeywords('BTC and ETH are leading');
      expect(keywords).toContain('BTC');
      expect(keywords).toContain('ETH');
    });

    it('should extract game-stylized tech companies', () => {
      const keywords = extractEventKeywords(
        'AIpple, AIphabet, and MAIcrosoft earnings'
      );
      expect(keywords).toContain('aipple');
      expect(keywords).toContain('aiphabet');
      expect(keywords).toContain('maicrosoft');
    });

    it('should extract regulatory bodies', () => {
      const keywords = extractEventKeywords('SEC and Federal Reserve meeting');
      expect(keywords).toContain('sec');
      expect(keywords).toContain('federal-reserve');
    });

    it('should extract game-stylized company names', () => {
      const keywords = extractEventKeywords(
        'TeslAI and NVIDAI lead the market'
      );
      expect(keywords).toContain('teslai');
      expect(keywords).toContain('nvidai');
    });

    it('should extract OpenAGI and game model names', () => {
      const keywords = extractEventKeywords(
        'OpenAGI announces SMH-5.2 Reflection'
      );
      expect(keywords).toContain('openagi');
      expect(keywords).toContain('openagi-model');
    });

    it('should extract game-stylized people names', () => {
      const keywords = extractEventKeywords(
        'AIlon Musk and Jensen HuAIng discuss'
      );
      expect(keywords).toContain('ailon-musk');
      expect(keywords).toContain('jensen-huaing');
    });

    it('should extract FSD as teslai-fsd', () => {
      const keywords = extractEventKeywords('TeslAI FSD is 99.9% complete');
      expect(keywords).toContain('teslai');
      expect(keywords).toContain('teslai-fsd');
    });

    it('should extract game model names', () => {
      const keywords = extractEventKeywords('SMH-5 and Claude-4 compete');
      expect(keywords).toContain('openagi-model');
      expect(keywords).toContain('aitropic-model');
    });

    it('should extract MetAI', () => {
      const keywords = extractEventKeywords('MetAI announces new features');
      expect(keywords).toContain('metai');
    });

    it('should extract AImazon', () => {
      const keywords = extractEventKeywords('AImazon expands cloud services');
      expect(keywords).toContain('aimazon');
    });

    it('should extract AItropic', () => {
      const keywords = extractEventKeywords('AItropic releases safety update');
      expect(keywords).toContain('aitropic');
    });

    it('should extract SpAIceX', () => {
      const keywords = extractEventKeywords('SpAIceX launches rocket');
      expect(keywords).toContain('spaicex');
    });
  });

  describe('Action extraction', () => {
    it('should extract crash events', () => {
      const keywords = extractEventKeywords('Market crashed today');
      expect(keywords).toContain('crash');
    });

    it('should extract surge events', () => {
      const keywords = extractEventKeywords('Bitcoin surging to new highs');
      expect(keywords).toContain('surge');
    });

    it('should extract announcements', () => {
      const keywords = extractEventKeywords('Company announces new product');
      expect(keywords).toContain('announcement');
    });

    it('should extract launches', () => {
      const keywords = extractEventKeywords('TeslAI launches new model');
      expect(keywords).toContain('launch');
    });

    it('should extract regulatory actions', () => {
      const keywords = extractEventKeywords('SEC approves BTC ETF');
      expect(keywords).toContain('approval');
    });

    it('should extract security events', () => {
      const keywords = extractEventKeywords('Exchange hacked, funds stolen');
      expect(keywords).toContain('security-breach');
    });

    it('should extract layoffs', () => {
      const keywords = extractEventKeywords('Tech company announces layoffs');
      expect(keywords).toContain('layoffs');
    });

    it('should extract M&A events', () => {
      const keywords = extractEventKeywords(
        'MAIcrosoft acquisition of gaming company'
      );
      expect(keywords).toContain('acquisition');
    });

    it('should extract IPO events', () => {
      const keywords = extractEventKeywords('Company files for IPO');
      expect(keywords).toContain('ipo');
    });

    // New action patterns
    it('should extract unveil events', () => {
      const keywords = extractEventKeywords('OpenAGI unveils new model');
      expect(keywords).toContain('unveil');
    });

    it('should extract reveal events', () => {
      const keywords = extractEventKeywords('Company reveals product roadmap');
      expect(keywords).toContain('reveal');
    });

    it('should extract hint events', () => {
      const keywords = extractEventKeywords('NVIDAI hints at new chip');
      expect(keywords).toContain('hint');
      expect(keywords).toContain('nvidai');
    });

    it('should extract claim events', () => {
      const keywords = extractEventKeywords('TeslAI claims FSD is complete');
      expect(keywords).toContain('claim');
      expect(keywords).toContain('teslai');
    });

    it('should extract partnership events', () => {
      const keywords = extractEventKeywords('Companies announce partnership');
      expect(keywords).toContain('partnership');
    });

    it('should extract release events', () => {
      const keywords = extractEventKeywords('AIpple releases new phone');
      expect(keywords).toContain('release');
      expect(keywords).toContain('aipple');
    });
  });

  describe('Complex scenarios', () => {
    it('should extract from realistic game market news', () => {
      const text = 'BTC breaks $94,000 as SEC approves ETF, surging +15%';
      const keywords = extractEventKeywords(text);

      expect(keywords).toContain('$94000');
      expect(keywords).toContain('+15%');
      expect(keywords).toContain('BTC');
      expect(keywords).toContain('sec');
      expect(keywords).toContain('approval');
      expect(keywords).toContain('surge');
    });

    it('should extract from game tech news', () => {
      const text = 'OpenAGI announces SMH-5 launch, MAIcrosoft stock up 10%';
      const keywords = extractEventKeywords(text);

      expect(keywords).toContain('openagi');
      expect(keywords).toContain('maicrosoft');
      expect(keywords).toContain('openagi-model');
      expect(keywords).toContain('announcement');
      expect(keywords).toContain('launch');
      expect(keywords).toContain('10%');
    });

    it('should limit keywords to 10', () => {
      const text = `
        BTC ETH SOL OpenAGI AIpple AIphabet MAIcrosoft 
        TeslAI AImazon MetAI NVIDAI crashes surges +50% $100k 
        January 15 Q1 2025 2026 announcement launch hack layoffs
      `;
      const keywords = extractEventKeywords(text);

      expect(keywords.length).toBeLessThanOrEqual(10);
    });

    it('should deduplicate keywords', () => {
      const text = 'TeslAI TeslAI teslai TESLAI';
      const keywords = extractEventKeywords(text);

      // Should not have duplicate teslai entries
      const teslaiCount = keywords.filter(
        (k) => k.toLowerCase() === 'teslai'
      ).length;
      expect(teslaiCount).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      const keywords = extractEventKeywords('');
      expect(keywords).toEqual([]);
    });

    it('should handle text with no matches', () => {
      const keywords = extractEventKeywords(
        'Hello world, nothing special here.'
      );
      expect(keywords).toEqual([]);
    });

    it('should handle special characters', () => {
      const keywords = extractEventKeywords('Price: $50,000!!! WOW!!!');
      expect(keywords).toContain('$50000');
    });

    it('should handle multiline text', () => {
      const text = `
        Breaking news:
        BTC surging to $100k
        Market celebrates
      `;
      const keywords = extractEventKeywords(text);
      expect(keywords).toContain('$100k');
      expect(keywords).toContain('BTC');
      expect(keywords).toContain('surge');
    });
  });
});
