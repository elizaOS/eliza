// Exercises the _common common path with deterministic cloud service fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetServiceAccountCacheForTests,
  createServiceLogger,
  readServiceAccountCaCert,
  readServiceAccountToken,
} from "../src";

const originalLogLevel = process.env.LOG_LEVEL;

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
  __resetServiceAccountCacheForTests();
});

describe("cloud services common", () => {
  test("logger respects LOG_LEVEL gating", () => {
    process.env.LOG_LEVEL = "warn";
    const logger = createServiceLogger("test");

    expect(logger.shouldLog("debug")).toBe(false);
    expect(logger.shouldLog("info")).toBe(false);
    expect(logger.shouldLog("warn")).toBe(true);
    expect(logger.shouldLog("error")).toBe(true);
  });

  test("service-account helpers return null outside a pod", () => {
    expect(readServiceAccountToken()).toBeNull();
    expect(readServiceAccountCaCert()).toBeNull();
  });
});
