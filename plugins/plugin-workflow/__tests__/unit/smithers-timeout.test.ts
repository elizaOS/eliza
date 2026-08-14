/** Exercises Smithers timeout validation without starting a workflow worker. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveSmithersTimeoutMs } from '../../src/services/smithers-runtime';

const originalTimeout = process.env.ELIZA_SMTHRS_TIMEOUT_MS;

beforeEach(() => {
  delete process.env.ELIZA_SMTHRS_TIMEOUT_MS;
});

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.ELIZA_SMTHRS_TIMEOUT_MS;
  else process.env.ELIZA_SMTHRS_TIMEOUT_MS = originalTimeout;
});

describe('Smithers timeout validation', () => {
  test('rejects explicit values outside the worker timer contract', () => {
    for (const timeoutMs of [
      0,
      -1,
      1.5,
      2_147_483_648,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => resolveSmithersTimeoutMs(timeoutMs)).toThrow(
        expect.objectContaining({ code: 'SMTHRS_TIMEOUT_INVALID' })
      );
    }
  });

  test('rejects every non-canonical operator syntax class', () => {
    for (const raw of [
      '',
      '0',
      '-1',
      '+1000',
      '01',
      '1.5',
      '1e3',
      '1E3',
      '1e+3',
      ' 1000',
      '1000 ',
      '2147483648',
      'Infinity',
      'NaN',
    ]) {
      process.env.ELIZA_SMTHRS_TIMEOUT_MS = raw;
      expect(() => resolveSmithersTimeoutMs()).toThrow(
        expect.objectContaining({ code: 'SMTHRS_TIMEOUT_INVALID' })
      );
    }
  });

  test('preserves the default and exact configured values', () => {
    expect(resolveSmithersTimeoutMs()).toBe(30 * 60 * 1_000);
    for (const [raw, expected] of [
      ['1', 1],
      ['1000', 1000],
      ['2147483647', 2_147_483_647],
    ] as const) {
      process.env.ELIZA_SMTHRS_TIMEOUT_MS = raw;
      expect(resolveSmithersTimeoutMs()).toBe(expected);
    }
  });

  test('gives an explicit request timeout precedence over operator configuration', () => {
    process.env.ELIZA_SMTHRS_TIMEOUT_MS = 'invalid';
    expect(resolveSmithersTimeoutMs(1234)).toBe(1234);
  });

  test('preserves the received token and bounds in typed error context', () => {
    process.env.ELIZA_SMTHRS_TIMEOUT_MS = '1e3';
    expect(() => resolveSmithersTimeoutMs()).toThrow(
      expect.objectContaining({
        code: 'SMTHRS_TIMEOUT_INVALID',
        context: {
          configured: '1e3',
          minimum: 1,
          maximum: 2_147_483_647,
        },
      })
    );
  });
});
