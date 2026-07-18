/**
 * Exercises the iOS store-engine release policy through the app package's real
 * Vitest lane so changed-file coverage observes the production module.
 */

import { describe, expect, it } from "vitest";
import { evaluateIosStoreEngineGate } from "../scripts/ios-store-engine-gate.mjs";

const env = (overrides: Record<string, string | undefined> = {}) => ({
  ELIZA_BUILD_VARIANT: undefined,
  ELIZA_RELEASE_AUTHORITY: undefined,
  ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: undefined,
  ELIZA_IOS_FULL_BUN_ENGINE: undefined,
  ...overrides,
});

describe("evaluateIosStoreEngineGate", () => {
  it("keeps the launch store build Cloud-only by default", () => {
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "store" }))
        .engineWillEmbed,
    ).toBe(false);
    expect(
      evaluateIosStoreEngineGate(
        env({ ELIZA_RELEASE_AUTHORITY: "apple-app-store" }),
      ).engineWillEmbed,
    ).toBe(false);
  });

  it("detects either store marker without accepting direct builds", () => {
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

  it("recognizes every explicit local-runtime disable spelling", () => {
    expect(evaluateIosStoreEngineGate(env()).localRuntimeDisabled).toBe(true);
    for (const value of ["0", "false", "no", "off", "OFF", " 0 "]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: value }),
        ).localRuntimeDisabled,
      ).toBe(true);
    }
    for (const value of ["1", "true", "yes", "anything"]) {
      expect(
        evaluateIosStoreEngineGate(
          env({ ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: value }),
        ).localRuntimeDisabled,
      ).toBe(false);
    }
  });

  it("embeds the engine for an explicit local custom store build", () => {
    const gate = evaluateIosStoreEngineGate(
      env({
        ELIZA_BUILD_VARIANT: "store",
        ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "1",
      }),
    );
    expect(gate.localRuntimeDisabled).toBe(false);
    expect(gate.engineWillEmbed).toBe(true);
  });

  it("lets an explicit engine request override Cloud-only omission", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(
        evaluateIosStoreEngineGate(env({ ELIZA_IOS_FULL_BUN_ENGINE: value }))
          .engineWillEmbed,
      ).toBe(true);
    }
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

  it("omits the engine from non-store builds without an explicit request", () => {
    expect(evaluateIosStoreEngineGate(env()).engineWillEmbed).toBe(false);
    expect(
      evaluateIosStoreEngineGate(env({ ELIZA_BUILD_VARIANT: "direct" }))
        .engineWillEmbed,
    ).toBe(false);
  });
});
