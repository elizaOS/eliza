import { afterEach, describe, expect, it } from "vitest";
import { shouldEnableMobileLocalInference } from "./mobile-local-inference-gate";

afterEach(() => {
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  delete process.env.ELIZA_LOCAL_LLAMA;
});

describe("shouldEnableMobileLocalInference", () => {
  it("returns false when neither env var is set", () => {
    expect(shouldEnableMobileLocalInference({})).toBe(false);
  });

  it("returns true when ELIZA_DEVICE_BRIDGE_ENABLED=1 (Capacitor APK path)", () => {
    expect(
      shouldEnableMobileLocalInference({ ELIZA_DEVICE_BRIDGE_ENABLED: "1" }),
    ).toBe(true);
  });

  it("returns true when ELIZA_LOCAL_LLAMA=1 (AOSP-only sub-task 2 path)", () => {
    expect(shouldEnableMobileLocalInference({ ELIZA_LOCAL_LLAMA: "1" })).toBe(
      true,
    );
  });

  it("returns true when both env vars are set", () => {
    expect(
      shouldEnableMobileLocalInference({
        ELIZA_DEVICE_BRIDGE_ENABLED: "1",
        ELIZA_LOCAL_LLAMA: "1",
      }),
    ).toBe(true);
  });

  it("rejects values that are not exactly '1'", () => {
    expect(
      shouldEnableMobileLocalInference({ ELIZA_DEVICE_BRIDGE_ENABLED: "true" }),
    ).toBe(false);
    expect(
      shouldEnableMobileLocalInference({ ELIZA_DEVICE_BRIDGE_ENABLED: "0" }),
    ).toBe(false);
    expect(shouldEnableMobileLocalInference({ ELIZA_LOCAL_LLAMA: "yes" })).toBe(
      false,
    );
  });

  it("trims whitespace before comparing", () => {
    expect(
      shouldEnableMobileLocalInference({ ELIZA_DEVICE_BRIDGE_ENABLED: " 1 " }),
    ).toBe(true);
    expect(
      shouldEnableMobileLocalInference({ ELIZA_LOCAL_LLAMA: "\t1\n" }),
    ).toBe(true);
  });

  it("defaults to process.env when no override provided", () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    expect(shouldEnableMobileLocalInference()).toBe(true);
  });
});
