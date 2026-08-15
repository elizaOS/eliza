/**
 * Unit tests for ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS validation.
 */
import { isElizaError } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
  MAX_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
  resolveDeferredPluginRegistrationTimeoutMs,
  startEliza,
} from "./eliza.ts";

describe("resolveDeferredPluginRegistrationTimeoutMs", () => {
  it("returns default 30,000 ms for unset or blank values", () => {
    expect(resolveDeferredPluginRegistrationTimeoutMs(undefined)).toBe(
      DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
    );
    expect(resolveDeferredPluginRegistrationTimeoutMs(null)).toBe(
      DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
    );
    expect(resolveDeferredPluginRegistrationTimeoutMs("")).toBe(
      DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
    );
    expect(resolveDeferredPluginRegistrationTimeoutMs("   \t\n  ")).toBe(
      DEFAULT_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
    );
  });

  it("accepts valid positive decimal integers in range 1..2147483647", () => {
    expect(resolveDeferredPluginRegistrationTimeoutMs("1")).toBe(1);
    expect(resolveDeferredPluginRegistrationTimeoutMs("30000")).toBe(30_000);
    expect(resolveDeferredPluginRegistrationTimeoutMs("  5000  ")).toBe(5_000);
    expect(resolveDeferredPluginRegistrationTimeoutMs("2147483647")).toBe(
      MAX_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
    );
  });

  it("rejects non-positive integer values with a typed fatal ElizaError", () => {
    for (const invalidValue of ["0", "-1", "-30000"]) {
      try {
        resolveDeferredPluginRegistrationTimeoutMs(invalidValue);
        expect.unreachable(`Should have thrown for input: ${invalidValue}`);
      } catch (err: unknown) {
        expect(isElizaError(err)).toBe(true);
        if (isElizaError(err)) {
          expect(err.code).toBe("INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT");
          expect(err.severity).toBe("fatal");
          expect(err.context).toMatchObject({
            raw: invalidValue,
            min: 1,
            max: MAX_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
          });
        }
      }
    }
  });

  it("rejects malformed or partial decimal inputs with a typed fatal ElizaError", () => {
    const malformedInputs = [
      "30000ms",
      "30_000",
      "10.5",
      "abc",
      "+1000",
      "0x10",
      "1e5",
      "Infinity",
      "NaN",
    ];

    for (const input of malformedInputs) {
      try {
        resolveDeferredPluginRegistrationTimeoutMs(input);
        expect.unreachable(`Should have thrown for input: ${input}`);
      } catch (err: unknown) {
        expect(isElizaError(err)).toBe(true);
        if (isElizaError(err)) {
          expect(err.code).toBe("INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT");
          expect(err.severity).toBe("fatal");
          expect(err.context).toMatchObject({
            raw: input,
            min: 1,
            max: MAX_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
          });
        }
      }
    }
  });

  it("rejects values exceeding Node timer range 2147483647", () => {
    const overflowInputs = ["2147483648", "99999999999999999999999"];

    for (const input of overflowInputs) {
      try {
        resolveDeferredPluginRegistrationTimeoutMs(input);
        expect.unreachable(`Should have thrown for input: ${input}`);
      } catch (err: unknown) {
        expect(isElizaError(err)).toBe(true);
        if (isElizaError(err)) {
          expect(err.code).toBe("INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT");
          expect(err.severity).toBe("fatal");
          expect(err.context).toMatchObject({
            raw: input,
            min: 1,
            max: MAX_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS,
          });
        }
      }
    }
  });
});

describe("startEliza pre-readiness watchdog validation", () => {
  const originalEnv = process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS = originalEnv;
    } else {
      delete process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;
    }
  });

  it("validates watchdog configuration up front before creating runtime resources", async () => {
    process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS =
      "invalid_timeout";

    try {
      await startEliza();
      expect.unreachable(
        "startEliza should have rejected invalid watchdog env var",
      );
    } catch (err: unknown) {
      expect(isElizaError(err)).toBe(true);
      if (isElizaError(err)) {
        expect(err.code).toBe("INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT");
        expect(err.severity).toBe("fatal");
      }
    }
  });

  it("validates a watchdog timeout hydrated from persisted config", async () => {
    delete process.env.ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS;

    await expect(
      startEliza({
        headless: true,
        configOverride: {
          env: {
            ELIZA_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT_MS: "persisted-invalid",
          },
        } as never,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DEFERRED_PLUGIN_REGISTRATION_TIMEOUT",
      severity: "fatal",
      context: { raw: "persisted-invalid" },
    });
  });
});
