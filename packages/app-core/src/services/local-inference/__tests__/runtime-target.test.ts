import { describe, expect, it } from "vitest";

import {
  inferencePlatformClass,
  inferenceRuntimeMode,
  isCapacitorNativeRuntime,
  readRuntimeModeEnvOverride,
} from "../runtime-target";

describe("readRuntimeModeEnvOverride", () => {
  it("returns null for unset / empty / unknown", () => {
    expect(readRuntimeModeEnvOverride({})).toBeNull();
    expect(readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "" })).toBeNull();
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "garbage" }),
    ).toBeNull();
  });

  it("recognises spawn aliases", () => {
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "spawn" }),
    ).toBe("spawn");
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "HTTP" }),
    ).toBe("spawn");
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "http-server" }),
    ).toBe("spawn");
  });

  it("recognises ffi aliases", () => {
    expect(readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "ffi" })).toBe(
      "ffi",
    );
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "ffi-streaming" }),
    ).toBe("ffi");
  });

  it("recognises native-bridge aliases", () => {
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "native-bridge" }),
    ).toBe("native-bridge");
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "native" }),
    ).toBe("native-bridge");
    expect(
      readRuntimeModeEnvOverride({ MILADY_INFERENCE_MODE: "capacitor" }),
    ).toBe("native-bridge");
  });

  it("accepts ELIZA_INFERENCE_MODE as a legacy alias", () => {
    expect(
      readRuntimeModeEnvOverride({ ELIZA_INFERENCE_MODE: "ffi" }),
    ).toBe("ffi");
  });

  it("prefers MILADY_INFERENCE_MODE over ELIZA_INFERENCE_MODE", () => {
    expect(
      readRuntimeModeEnvOverride({
        MILADY_INFERENCE_MODE: "ffi",
        ELIZA_INFERENCE_MODE: "spawn",
      }),
    ).toBe("ffi");
  });
});

describe("inferenceRuntimeMode", () => {
  it("env override wins over every heuristic", () => {
    expect(
      inferenceRuntimeMode({
        env: { MILADY_INFERENCE_MODE: "ffi" },
        platform: "darwin",
        isCapacitorNative: false,
      }),
    ).toBe("ffi");

    expect(
      inferenceRuntimeMode({
        env: { MILADY_INFERENCE_MODE: "spawn" },
        platform: "ios",
        isCapacitorNative: true,
      }),
    ).toBe("spawn");
  });

  it("Capacitor native marker forces ffi when no env override", () => {
    expect(
      inferenceRuntimeMode({
        env: {},
        platform: "darwin",
        isCapacitorNative: true,
      }),
    ).toBe("ffi");
  });

  it("iOS / Android map to ffi", () => {
    expect(
      inferenceRuntimeMode({
        env: {},
        platform: "ios" as NodeJS.Platform,
        isCapacitorNative: false,
      }),
    ).toBe("ffi");
    expect(
      inferenceRuntimeMode({
        env: {},
        platform: "android" as NodeJS.Platform,
        isCapacitorNative: false,
      }),
    ).toBe("ffi");
  });

  it("darwin / linux / win32 map to spawn", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(
        inferenceRuntimeMode({
          env: {},
          platform,
          isCapacitorNative: false,
        }),
      ).toBe("spawn");
    }
  });

  it("exotic platforms default to spawn", () => {
    expect(
      inferenceRuntimeMode({
        env: {},
        platform: "freebsd" as NodeJS.Platform,
        isCapacitorNative: false,
      }),
    ).toBe("spawn");
    expect(
      inferenceRuntimeMode({
        env: {},
        platform: "aix" as NodeJS.Platform,
        isCapacitorNative: false,
      }),
    ).toBe("spawn");
  });

  it("unknown override values are ignored (fall back to platform)", () => {
    expect(
      inferenceRuntimeMode({
        env: { MILADY_INFERENCE_MODE: "bogus" },
        platform: "linux",
        isCapacitorNative: false,
      }),
    ).toBe("spawn");
  });
});

describe("inferencePlatformClass", () => {
  it("spawn → desktop", () => {
    expect(inferencePlatformClass("spawn")).toBe("desktop");
  });

  it("ffi → mobile", () => {
    expect(inferencePlatformClass("ffi")).toBe("mobile");
  });

  it("native-bridge → mobile", () => {
    expect(inferencePlatformClass("native-bridge")).toBe("mobile");
  });
});

describe("isCapacitorNativeRuntime", () => {
  it("returns false when Capacitor global is absent", () => {
    expect(isCapacitorNativeRuntime({} as typeof globalThis)).toBe(false);
  });

  it("returns false when isNativePlatform is not a function", () => {
    const g = { Capacitor: {} } as unknown as typeof globalThis;
    expect(isCapacitorNativeRuntime(g)).toBe(false);
  });

  it("returns true when the Capacitor probe says so", () => {
    const g = {
      Capacitor: { isNativePlatform: () => true },
    } as unknown as typeof globalThis;
    expect(isCapacitorNativeRuntime(g)).toBe(true);
  });

  it("swallows probe throws and returns false", () => {
    const g = {
      Capacitor: {
        isNativePlatform: () => {
          throw new Error("boom");
        },
      },
    } as unknown as typeof globalThis;
    expect(isCapacitorNativeRuntime(g)).toBe(false);
  });
});
