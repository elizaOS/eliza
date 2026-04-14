/**
 * Test gating utilities for real integration tests.
 *
 * Usage:
 *   import { skipWithout, skipWithoutLive, skipWithoutAnyLLM } from "./skip-without";
 *
 *   describe("Discord connector", () => {
 *     skipWithout("DISCORD_BOT_TOKEN");
 *     // ... tests that require a real Discord bot
 *   });
 */

import { describe, it, test } from "vitest";
import { selectLiveProvider, isLiveTestEnabled } from "./live-provider";

/**
 * Skip the current test suite if any of the given environment variables are missing.
 * Call at the top of a describe block.
 */
export function skipWithout(
  envVarOrVars: string | string[],
): void {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.filter((v) => !process.env[v]?.trim());
  if (missing.length > 0) {
    test.skip(`Missing env: ${missing.join(", ")}`);
  }
}

/**
 * Create a describe.skipIf wrapper for when env vars are missing.
 * Use as: describeWithout("DISCORD_BOT_TOKEN")("Discord tests", () => { ... })
 */
export function describeWithout(envVarOrVars: string | string[]) {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.some((v) => !process.env[v]?.trim());
  return describe.skipIf(missing);
}

/**
 * Create an it.skipIf wrapper for when env vars are missing.
 */
export function itWithout(envVarOrVars: string | string[]) {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.some((v) => !process.env[v]?.trim());
  return it.skipIf(missing);
}

/**
 * Skip unless MILADY_LIVE_TEST=1 (or ELIZA_LIVE_TEST=1 or LIVE=1).
 */
export function skipWithoutLive(): void {
  if (!isLiveTestEnabled()) {
    test.skip("MILADY_LIVE_TEST=1 or ELIZA_LIVE_TEST=1 not set");
  }
}

/**
 * describe.skipIf wrapper for live test gate.
 */
export const describeLive = describe.skipIf(!isLiveTestEnabled());

/**
 * it.skipIf wrapper for live test gate.
 */
export const itLive = it.skipIf(!isLiveTestEnabled());

/**
 * Skip unless at least one LLM provider API key is available.
 */
export function skipWithoutAnyLLM(): void {
  if (!selectLiveProvider()) {
    test.skip("No LLM provider API key available");
  }
}

/**
 * describe.skipIf wrapper for LLM availability.
 */
export const describeLLM = describe.skipIf(!selectLiveProvider());

/**
 * it.skipIf wrapper for LLM availability.
 */
export const itLLM = it.skipIf(!selectLiveProvider());
