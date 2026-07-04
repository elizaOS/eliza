/**
 * Unit tests for the Ios Store Engine Gate app packaging script behavior and
 * platform guardrails.
 */
import { describe, expect, it } from "vitest";
import { evaluateIosStoreEngineGate } from "./ios-store-engine-gate.mjs";

/** Build an env with the iOS engine-gate vars unset, then apply overrides. */
const env = (overrides = {}) => ({
  ELIZA_BUILD_VARIANT: undefined,
  ELIZA_RELEASE_AUTHORITY: undefined,
  ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: undefined,
  ELIZA_IOS_FULL_BUN_ENGINE: undefined,
  ...overrides,
});

describe("evaluateIosStoreEngineGate (#8861)", () => {
  it("a store build with the local runtime left enabled EMBEDS the engine (the regression guard)", () => {
    // This is the exact case the bug shipped wrong: store IPA without the
    // engine → "start local agent" hard-fails. It MUST embed.
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "store" }))
        .engineWillEmbed,
    ).toBe(true);
    expect(
      evaluateIosStoreEngineGate(
        env({ ELIZA_RELEASE_AUTHORITY: "apple-app-store" }),
      ).engineWillEmbed,
    ).toBe(true);
  });

  it("detects the store variant from either flag (case-insensitive)", () => {
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "STORE" }))
        .storeVariant,
    ).toBe(true);
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "direct" }))
        .storeVariant,
    ).toBe(false);
    expect(evaluateIosStoreEngineGate(env()).storeVariant).toBe(false);
  });

  it("defaults the local runtime ON (must be explicitly disabled)", () => {
    expect(evaluateIosStoreEngineGate(env()).localRuntimeDisabled).toBe(false);
    for (const v of ["0", "false", "no", "off", "OFF", " 0 "]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: v }),
        ).localRuntimeDisabled,
      ).toBe(true);
    }
    for (const v of ["1", "true", "yes", "anything"]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: v }),
        ).localRuntimeDisabled,
      ).toBe(false);
    }
  });

  it("an intentional cloud-only store build (local runtime disabled) omits the engine", () => {
    const gate = evaluateIosStoreEngineGate(
      env({
        ELIZA_BUILD_VARIANT: "store",
        ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
      }),
    );
    expect(gate.storeVariant).toBe(true);
    expect(gate.localRuntimeDisabled).toBe(true);
    expect(gate.engineWillEmbed).toBe(false);
  });

  it("ELIZA_IOS_FULL_BUN_ENGINE forces the engine even off a store build, and beats a disabled local runtime", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      expect(
        evaluateIosStoreEngineGate(env({ ELIZA_IOS_FULL_BUN_ENGINE: v }))
          .engineWillEmbed,
      ).toBe(true);
    }
    // forced wins over an explicit cloud-only disable.
    expect(
      evaluateIosStoreEngineGate(
        env({
          ELIZA_BUILD_VARIANT: "store",
          ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
          ELIZA_IOS_FULL_BUN_ENGINE: "1",
        }),
      ).engineWillEmbed,
    ).toBe(true);
  });

  it("a non-store build without forcing does NOT embed the engine", () => {
    expect(evaluateIosStoreEngineGate(env()).engineWillEmbed).toBe(false);
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "direct" }))
        .engineWillEmbed,
    ).toBe(false);
  });
});
