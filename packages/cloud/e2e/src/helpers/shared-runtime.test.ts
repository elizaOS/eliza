/**
 * Focused deterministic coverage of the shared-runtime warming classifier:
 * only the two named warming codes on a retryable 503 classify as warming;
 * foreign, missing, or non-retryable envelopes are real failures. Run with
 * `bun test packages/cloud/e2e/src/helpers/shared-runtime.test.ts` (the
 * package's Playwright lane matches only `tests/`).
 */

import { expect, test } from "bun:test";
import { isSharedRuntimeWarming } from "./shared-runtime";

test("classifies exactly the two named warming codes on a retryable 503", () => {
  expect(
    isSharedRuntimeWarming(503, {
      retryable: true,
      code: "agent_cache_warming",
    }),
  ).toBe(true);
  expect(
    isSharedRuntimeWarming(503, {
      retryable: true,
      code: "shared_runtime_cache_warming",
    }),
  ).toBe(true);
});

test("rejects retryable 503s with foreign or missing codes", () => {
  for (const code of [
    "inference_unavailable",
    "agent_cache_unavailable",
    "shared_runtime_context_unavailable",
  ]) {
    expect(isSharedRuntimeWarming(503, { retryable: true, code })).toBe(false);
  }
  expect(isSharedRuntimeWarming(503, { retryable: true })).toBe(false);
  expect(isSharedRuntimeWarming(503, { retryable: true, code: 7 })).toBe(false);
});

test("rejects non-503 statuses, non-retryable envelopes, and non-object bodies", () => {
  expect(
    isSharedRuntimeWarming(500, {
      retryable: true,
      code: "agent_cache_warming",
    }),
  ).toBe(false);
  expect(
    isSharedRuntimeWarming(503, {
      retryable: false,
      code: "agent_cache_warming",
    }),
  ).toBe(false);
  expect(isSharedRuntimeWarming(503, null)).toBe(false);
  expect(isSharedRuntimeWarming(503, "warming")).toBe(false);
});
