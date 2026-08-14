/** Exercises Smithers timeout validation without starting a workflow worker. */

import { afterEach, describe, expect, test } from 'bun:test';
import { resolveSmithersTimeoutMs } from '../../src/services/smithers-runtime';

const originalTimeout = process.env.ELIZA_SMTHRS_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.ELIZA_SMTHRS_TIMEOUT_MS;
  else process.env.ELIZA_SMTHRS_TIMEOUT_MS = originalTimeout;
});

describe('Smithers timeout validation', () => {
  test('rejects values that cannot be represented by the worker timer', () => {
    for (const timeoutMs of [0, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY]) {
      expect(() => resolveSmithersTimeoutMs(timeoutMs)).toThrow(
        expect.objectContaining({ code: 'SMTHRS_TIMEOUT_INVALID' })
      );
    }
  });

  test('rejects malformed operator syntax without changing valid boundaries', () => {
    for (const raw of ['', '1e3', ' 1.5 ', '2147483648']) {
      process.env.ELIZA_SMTHRS_TIMEOUT_MS = raw;
      expect(() => resolveSmithersTimeoutMs()).toThrow(
        expect.objectContaining({ code: 'SMTHRS_TIMEOUT_INVALID' })
      );
    }

    process.env.ELIZA_SMTHRS_TIMEOUT_MS = '1000';
    expect(resolveSmithersTimeoutMs()).toBe(1000);
    expect(resolveSmithersTimeoutMs(2_147_483_647)).toBe(2_147_483_647);
  });
});
