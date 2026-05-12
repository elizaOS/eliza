import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { containersEnv } from "@/lib/config/containers-env";

const KEYS = [
  "CONTAINERS_HCLOUD_LOCATION",
  "HCLOUD_LOCATION",
  "WARM_POOL_ENABLED",
  "WARM_POOL_MAX_SIZE",
  "WARM_POOL_MIN_SIZE",
] as const;

type Snapshot = Partial<Record<(typeof KEYS)[number], string | undefined>>;

function snapshot(): Snapshot {
  const out: Snapshot = {};
  for (const k of KEYS) out[k] = process.env[k];
  return out;
}

function restore(snap: Snapshot): void {
  for (const k of KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("containers env — warm pool defaults", () => {
  let snap: Snapshot;
  beforeEach(() => {
    snap = snapshot();
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    restore(snap);
  });

  test("default location is US (Ashburn)", () => {
    expect(containersEnv.defaultHcloudLocation()).toBe("ash");
  });

  test("CONTAINERS_HCLOUD_LOCATION overrides default", () => {
    process.env.CONTAINERS_HCLOUD_LOCATION = "hil";
    expect(containersEnv.defaultHcloudLocation()).toBe("hil");
  });

  test("HCLOUD_LOCATION is the secondary alias", () => {
    process.env.HCLOUD_LOCATION = "fsn1";
    expect(containersEnv.defaultHcloudLocation()).toBe("fsn1");
  });

  test("warmPoolEnabled defaults false", () => {
    expect(containersEnv.warmPoolEnabled()).toBe(false);
  });

  test("warmPoolEnabled accepts 'true' and '1'", () => {
    process.env.WARM_POOL_ENABLED = "true";
    expect(containersEnv.warmPoolEnabled()).toBe(true);
    process.env.WARM_POOL_ENABLED = "1";
    expect(containersEnv.warmPoolEnabled()).toBe(true);
  });

  test("warmPoolEnabled is false for 'yes', '0', empty", () => {
    for (const v of ["yes", "0", "", "false"]) {
      process.env.WARM_POOL_ENABLED = v;
      expect(containersEnv.warmPoolEnabled()).toBe(false);
    }
  });

  test("warmPoolMaxSize defaults to 10", () => {
    expect(containersEnv.warmPoolMaxSize()).toBe(10);
  });

  test("warmPoolMaxSize honors override and clamps absurd values", () => {
    process.env.WARM_POOL_MAX_SIZE = "5";
    expect(containersEnv.warmPoolMaxSize()).toBe(5);

    process.env.WARM_POOL_MAX_SIZE = "9999";
    expect(containersEnv.warmPoolMaxSize()).toBe(50);

    process.env.WARM_POOL_MAX_SIZE = "0";
    expect(containersEnv.warmPoolMaxSize()).toBe(10); // invalid → default

    process.env.WARM_POOL_MAX_SIZE = "not-a-number";
    expect(containersEnv.warmPoolMaxSize()).toBe(10);
  });

  test("warmPoolMinSize defaults to 1", () => {
    expect(containersEnv.warmPoolMinSize()).toBe(1);
  });

  test("warmPoolMinSize accepts override (including 0)", () => {
    process.env.WARM_POOL_MIN_SIZE = "0";
    expect(containersEnv.warmPoolMinSize()).toBe(0);

    process.env.WARM_POOL_MIN_SIZE = "3";
    expect(containersEnv.warmPoolMinSize()).toBe(3);
  });
});
