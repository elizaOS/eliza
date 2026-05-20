/**
 * Type Guards Unit Tests
 *
 * Tests for runtime type checking utilities.
 */

import { describe, expect, test } from 'bun:test';
import {
  isFiniteNumber,
  isObject,
  isString,
  isValidDate,
  isValidEventType,
  isValidMarketType,
  isValidPointsToward,
  isValidQuestionStatus,
  isValidTradeAction,
  isValidVisibility,
  VALID_EVENT_TYPES,
  VALID_MARKET_TYPES,
  VALID_QUESTION_STATUSES,
  VALID_TRADE_ACTIONS,
  VALID_VISIBILITY_VALUES,
} from '../../types/guards';

describe('Type Guards', () => {
  describe('isValidEventType', () => {
    test('returns true for valid event types', () => {
      for (const type of VALID_EVENT_TYPES) {
        expect(isValidEventType(type)).toBe(true);
      }
    });

    test('returns false for invalid event types', () => {
      expect(isValidEventType('invalid')).toBe(false);
      expect(isValidEventType('')).toBe(false);
      expect(isValidEventType('ANNOUNCEMENT')).toBe(false); // case sensitive
    });
  });

  describe('isValidVisibility', () => {
    test('returns true for valid visibility values', () => {
      for (const vis of VALID_VISIBILITY_VALUES) {
        expect(isValidVisibility(vis)).toBe(true);
      }
    });

    test('returns false for invalid visibility values', () => {
      expect(isValidVisibility('invalid')).toBe(false);
      expect(isValidVisibility('')).toBe(false);
      expect(isValidVisibility('PUBLIC')).toBe(false); // case sensitive
    });
  });

  describe('isValidPointsToward', () => {
    test('returns true for YES', () => {
      expect(isValidPointsToward('YES')).toBe(true);
    });

    test('returns true for NO', () => {
      expect(isValidPointsToward('NO')).toBe(true);
    });

    test('returns true for null', () => {
      expect(isValidPointsToward(null)).toBe(true);
    });

    test('returns false for undefined', () => {
      expect(isValidPointsToward(undefined)).toBe(false);
    });

    test('returns false for invalid values', () => {
      expect(isValidPointsToward('yes')).toBe(false);
      expect(isValidPointsToward('MAYBE')).toBe(false);
    });
  });

  describe('isValidMarketType', () => {
    test('returns true for valid market types', () => {
      for (const type of VALID_MARKET_TYPES) {
        expect(isValidMarketType(type)).toBe(true);
      }
    });

    test('returns false for invalid market types', () => {
      expect(isValidMarketType('invalid')).toBe(false);
      expect(isValidMarketType('PERP')).toBe(false); // case sensitive
    });
  });

  describe('isValidTradeAction', () => {
    test('returns true for valid trade actions', () => {
      for (const action of VALID_TRADE_ACTIONS) {
        expect(isValidTradeAction(action)).toBe(true);
      }
    });

    test('returns false for invalid trade actions', () => {
      expect(isValidTradeAction('invalid')).toBe(false);
      expect(isValidTradeAction('BUY')).toBe(false);
    });
  });

  describe('isValidQuestionStatus', () => {
    test('returns true for valid question statuses', () => {
      for (const status of VALID_QUESTION_STATUSES) {
        expect(isValidQuestionStatus(status)).toBe(true);
      }
    });

    test('returns false for invalid question statuses', () => {
      expect(isValidQuestionStatus('invalid')).toBe(false);
      expect(isValidQuestionStatus('ACTIVE')).toBe(false); // case sensitive
    });
  });

  describe('isObject', () => {
    test('returns true for plain objects', () => {
      expect(isObject({})).toBe(true);
      expect(isObject({ key: 'value' })).toBe(true);
      expect(isObject(Object.create(null))).toBe(true);
    });

    test('returns false for null', () => {
      expect(isObject(null)).toBe(false);
    });

    test('returns false for arrays', () => {
      expect(isObject([])).toBe(false);
      expect(isObject([1, 2, 3])).toBe(false);
    });

    test('returns false for primitives', () => {
      expect(isObject('string')).toBe(false);
      expect(isObject(123)).toBe(false);
      expect(isObject(true)).toBe(false);
      expect(isObject(undefined)).toBe(false);
    });

    test('returns false for class instances', () => {
      expect(isObject(new Date())).toBe(false);
      expect(isObject(new Map())).toBe(false);
      expect(isObject(new Set())).toBe(false);
    });

    test('returns false for functions', () => {
      expect(isObject(() => {})).toBe(false);
    });
  });

  describe('isString', () => {
    test('returns true for strings', () => {
      expect(isString('')).toBe(true);
      expect(isString('hello')).toBe(true);
      expect(isString(String('test'))).toBe(true);
    });

    test('returns false for non-strings', () => {
      expect(isString(123)).toBe(false);
      expect(isString(null)).toBe(false);
      expect(isString(undefined)).toBe(false);
      expect(isString({})).toBe(false);
      expect(isString([])).toBe(false);
    });
  });

  describe('isFiniteNumber', () => {
    test('returns true for finite numbers', () => {
      expect(isFiniteNumber(0)).toBe(true);
      expect(isFiniteNumber(42)).toBe(true);
      expect(isFiniteNumber(-100)).toBe(true);
      expect(isFiniteNumber(3.14159)).toBe(true);
    });

    test('returns false for Infinity', () => {
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
    });

    test('returns false for NaN', () => {
      expect(isFiniteNumber(NaN)).toBe(false);
    });

    test('returns false for non-numbers', () => {
      expect(isFiniteNumber('123')).toBe(false);
      expect(isFiniteNumber(null)).toBe(false);
      expect(isFiniteNumber(undefined)).toBe(false);
    });
  });

  describe('isValidDate', () => {
    test('returns true for valid Date objects', () => {
      expect(isValidDate(new Date())).toBe(true);
      expect(isValidDate(new Date('2024-01-01'))).toBe(true);
    });

    test('returns false for invalid Date objects', () => {
      expect(isValidDate(new Date('invalid'))).toBe(false);
    });

    test('returns false for non-Date values', () => {
      expect(isValidDate('2024-01-01')).toBe(false);
      expect(isValidDate(Date.now())).toBe(false);
      expect(isValidDate(null)).toBe(false);
      expect(isValidDate({})).toBe(false);
    });
  });
});
