/**
 * Pins independent rollout controls for inference decision caches and the
 * stronger authorization-cache safety boundary.
 */

import { expect, test } from "bun:test";
import { isHotPathCachesEnabled, isInferenceAuthCacheEnabled } from "./inference-hot-path-caches";

test("authorization caching is fail-closed and independent of other hot-path caches", () => {
  expect(isInferenceAuthCacheEnabled({})).toBe(false);
  expect(
    isInferenceAuthCacheEnabled({
      INFERENCE_HOT_PATH_CACHES: "true",
    }),
  ).toBe(false);
  expect(
    isInferenceAuthCacheEnabled({
      INFERENCE_AUTH_CACHE_ENABLED: "true",
    }),
  ).toBe(true);
  expect(
    isInferenceAuthCacheEnabled({
      INFERENCE_AUTH_CACHE_ENABLED: "TRUE",
    }),
  ).toBe(false);
});

test("general decision caches retain their existing flag contract", () => {
  expect(isHotPathCachesEnabled({})).toBe(false);
  expect(isHotPathCachesEnabled({ INFERENCE_HOT_PATH_CACHES: "true" })).toBe(true);
});
