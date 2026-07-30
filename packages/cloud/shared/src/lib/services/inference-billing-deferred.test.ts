/**
 * Unit tests for the Tier-3 deferred billing admission flag and the in-isolate
 * refusal blocklist (#9899). Deferred settlement itself lives in the Durable
 * Object admission lane (`organization-inference-admission.ts`).
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, test } from "bun:test";
import {
  __clearDeferredAdmissionState,
  isDeferredAdmissionEnabled,
  isOrgAdmissionRefused,
  markOrgAdmissionRefused,
} from "./inference-billing-deferred";

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

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

describe("refusal blocklist", () => {
  beforeEach(() => {
    __clearDeferredAdmissionState();
  });

  test("marked org is refused; unmarked org is not; clear resets", () => {
    const org = uid("org");
    expect(isOrgAdmissionRefused(org)).toBe(false);
    markOrgAdmissionRefused(org);
    expect(isOrgAdmissionRefused(org)).toBe(true);
    expect(isOrgAdmissionRefused(uid("other-org"))).toBe(false);
    __clearDeferredAdmissionState();
    expect(isOrgAdmissionRefused(org)).toBe(false);
  });
});
