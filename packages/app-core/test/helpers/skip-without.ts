/** Env-based gates for live and integration tests. */

import { describe, it, test } from "vitest";
import { isLiveTestEnabled, selectLiveProvider } from "./live-provider.ts";

/** Skips the current suite when required env vars are missing. */
export function skipWithout(envVarOrVars: string | string[]): void {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.filter((v) => !process.env[v]?.trim());
  if (missing.length > 0) {
    test.skip(`Missing env: ${missing.join(", ")}`);
  }
}

/** Returns a `describe.skipIf` wrapper for env-based gates. */
export function describeWithout(envVarOrVars: string | string[]) {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.some((v) => !process.env[v]?.trim());
  return describe.skipIf(missing);
}

/** Returns an `it.skipIf` wrapper for env-based gates. */
export function itWithout(envVarOrVars: string | string[]) {
  const vars = Array.isArray(envVarOrVars) ? envVarOrVars : [envVarOrVars];
  const missing = vars.some((v) => !process.env[v]?.trim());
  return it.skipIf(missing);
}

/** Skips unless the live-test gate is enabled. */
export function skipWithoutLive(): void {
  if (!isLiveTestEnabled()) {
    test.skip("ELIZA_LIVE_TEST=1 not set");
  }
}

/** `describe.skipIf` wrapper for the live-test gate. */
export const describeLive = describe.skipIf(!isLiveTestEnabled());

/** `it.skipIf` wrapper for the live-test gate. */
export const itLive = it.skipIf(!isLiveTestEnabled());

/** Skips unless at least one LLM provider API key is available. */
export function skipWithoutAnyLLM(): void {
  if (!selectLiveProvider()) {
    test.skip("No LLM provider API key available");
  }
}

/** `describe.skipIf` wrapper for LLM availability. */
export const describeLLM = describe.skipIf(!selectLiveProvider());

/** `it.skipIf` wrapper for LLM availability. */
export const itLLM = it.skipIf(!selectLiveProvider());
