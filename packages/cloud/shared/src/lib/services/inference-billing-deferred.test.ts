/**
 * Unit tests for the Tier-3 deferred billing admission flag (#9899). Deferred
 * settlement itself lives in the Durable Object admission lane.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { describe, expect, test } from "bun:test";
import { isDeferredAdmissionEnabled } from "./inference-billing-deferred";

describe("isDeferredAdmissionEnabled", () => {
  test("only an exact 'true' enables it (default-safe)", () => {
    expect(isDeferredAdmissionEnabled({})).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "1" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "TRUE" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "true" })).toBe(true);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: " true " })).toBe(true);
  });
});
