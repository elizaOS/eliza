/**
 * Covers the autoscaler's safer defaults:
 *   - defaultHcloudServerType bumped cpx32 → ccx33 so the out-of-the-box pair
 *     with the 8-agents/node default capacity gives ~4 GB/agent (cpx32 was
 *     ~1 GB/agent under the same capacity and got OOM-killed in prod). ccx33
 *     was picked over a same-sized shared type (cpx51) because Hetzner's API
 *     rejects cpx51 creation in fsn1/nbg1/hel1 in practice.
 *   - defaultAutoscaleNodeCapacity is env-overridable (CONTAINERS_AUTOSCALE_
 *     NODE_CAPACITY) so ops can right-size a smaller server type without a
 *     code change. Clamped to [1, 64]; falls back to 8 on garbage/missing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { containersEnv } from "../../config/containers-env";

const CAP = "CONTAINERS_AUTOSCALE_NODE_CAPACITY";
const PRIMARY = "CONTAINERS_HCLOUD_SERVER_TYPE";
const LEGACY = "HCLOUD_SERVER_TYPE";

function restore(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

describe("defaultHcloudServerType", () => {
  let originalPrimary: string | undefined;
  let originalLegacy: string | undefined;
  beforeEach(() => {
    originalPrimary = process.env[PRIMARY];
    originalLegacy = process.env[LEGACY];
  });
  afterEach(() => {
    restore(PRIMARY, originalPrimary);
    restore(LEGACY, originalLegacy);
  });

  test("falls back to ccx33 (32 GB amd64, dedicated vCPU) when no env is set", () => {
    delete process.env[PRIMARY];
    delete process.env[LEGACY];
    expect(containersEnv.defaultHcloudServerType()).toBe("ccx33");
  });

  test("primary env wins over legacy alias", () => {
    process.env[PRIMARY] = "ccx33";
    process.env[LEGACY] = "cpx41";
    expect(containersEnv.defaultHcloudServerType()).toBe("ccx33");
  });

  test("honors legacy HCLOUD_SERVER_TYPE if only it is set", () => {
    delete process.env[PRIMARY];
    process.env[LEGACY] = "cpx41";
    expect(containersEnv.defaultHcloudServerType()).toBe("cpx41");
  });
});

describe("defaultAutoscaleNodeCapacity", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[CAP];
  });
  afterEach(() => {
    restore(CAP, original);
  });

  test("defaults to 8 when env is unset", () => {
    delete process.env[CAP];
    expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(8);
  });

  test("reads a valid positive integer from env", () => {
    process.env[CAP] = "4";
    expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(4);
  });

  test("floors fractional values", () => {
    process.env[CAP] = "5.9";
    expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(5);
  });

  test("clamps an oversized value to 64", () => {
    process.env[CAP] = "999";
    expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(64);
  });

  test("falls back to 8 on zero, negative, or non-numeric", () => {
    for (const raw of ["0", "-1", "abc", ""]) {
      process.env[CAP] = raw;
      expect(containersEnv.defaultAutoscaleNodeCapacity()).toBe(8);
    }
  });
});
