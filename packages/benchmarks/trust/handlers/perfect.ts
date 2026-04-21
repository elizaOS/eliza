/**
 * Oracle / Perfect handler for the Trust Security Benchmark.
 * Returns ground-truth answers for all test cases.
 * Used to validate the benchmark framework itself.
 */

import type { TrustBenchmarkHandler } from "../types";
import { TEST_CORPUS } from "../corpus";

const corpusMap = new Map(TEST_CORPUS.map((tc) => [tc.id, tc]));

/**
 * Finds matching test case by input text and returns ground truth.
 */
function findTestCase(
  input: string,
): { expectedMalicious: boolean } | undefined {
  for (const tc of TEST_CORPUS) {
    if (tc.input === input) return tc;
  }
  return undefined;
}

export const perfectHandler: TrustBenchmarkHandler = {
  name: "oracle",

  async detectInjection(message: string) {
    const tc = findTestCase(message);
    if (!tc) return { detected: false, confidence: 0 };
    return {
      detected: tc.expectedMalicious,
      confidence: tc.expectedMalicious ? 1.0 : 0.0,
    };
  },

  async detectSocialEngineering(message: string) {
    const tc = findTestCase(message);
    if (!tc) return { detected: false, confidence: 0 };
    return {
      detected: tc.expectedMalicious,
      confidence: tc.expectedMalicious ? 1.0 : 0.0,
    };
  },

  async detectImpersonation(username: string, _existingUsers: string[]) {
    // For impersonation, the "input" is the username
    const tc = findTestCase(username);
    if (!tc) return { detected: false, confidence: 0 };
    return {
      detected: tc.expectedMalicious,
      confidence: tc.expectedMalicious ? 1.0 : 0.0,
    };
  },

  async detectCredentialTheft(message: string) {
    const tc = findTestCase(message);
    if (!tc) return { detected: false, confidence: 0 };
    return {
      detected: tc.expectedMalicious,
      confidence: tc.expectedMalicious ? 1.0 : 0.0,
    };
  },
};
