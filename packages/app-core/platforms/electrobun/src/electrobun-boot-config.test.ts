/** Exercises electrobun boot config behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  ELECTROBUN_BOOT_CONFIG_STORE_KEY,
  type ElectrobunBootConfigWindow,
  updateElectrobunBootConfig,
} from "./bridge/electrobun-boot-config";

describe("Electrobun boot config bridge", () => {
  it("writes the current window key, legacy key, and symbol store", () => {
    const globalObject: ElectrobunBootConfigWindow = {};

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://127.0.0.1:31337",
      apiToken: "token",
    });

    expect(nextConfig).toEqual({
      apiBase: "http://127.0.0.1:31337",
      apiToken: "token",
    });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("prefers the current key while preserving existing fields", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: {
        branding: { name: "Eliza" },
        apiBase: "http://old.example",
      },
      __ELIZA_APP_BOOT_CONFIG__: {
        branding: { name: "Legacy" },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://127.0.0.1:31337",
    });

    expect(nextConfig).toEqual({
      branding: { name: "Eliza" },
      apiBase: "http://127.0.0.1:31337",
    });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
  });

  it("falls back to the legacy key when the current key is absent", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZA_APP_BOOT_CONFIG__: {
        apiToken: "legacy-token",
        featureFlags: { kiosk: true },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiToken: "next-token",
    });

    expect(nextConfig).toEqual({
      apiToken: "next-token",
      featureFlags: { kiosk: true },
    });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("reads the existing config from the symbol store when both window keys are absent", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      [ELECTROBUN_BOOT_CONFIG_STORE_KEY]: {
        current: {
          apiBase: "http://store.example",
          surfaceMode: "kiosk",
        },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://next.example",
    });

    expect(nextConfig).toEqual({
      apiBase: "http://next.example",
      surfaceMode: "kiosk",
    });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
  });

  it("prefers the current key over the legacy key and the symbol store", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: { apiBase: "http://canonical.example" },
      __ELIZA_APP_BOOT_CONFIG__: { apiBase: "http://legacy.example" },
      [ELECTROBUN_BOOT_CONFIG_STORE_KEY]: {
        current: { apiBase: "http://store.example" },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {});

    expect(nextConfig).toEqual({ apiBase: "http://canonical.example" });
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("prefers the legacy key over the symbol store", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZA_APP_BOOT_CONFIG__: { apiToken: "legacy-token" },
      [ELECTROBUN_BOOT_CONFIG_STORE_KEY]: {
        current: { apiToken: "store-token" },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {});

    expect(nextConfig).toEqual({ apiToken: "legacy-token" });
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("starts from an empty config when every source is nullish", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: undefined,
      __ELIZA_APP_BOOT_CONFIG__: undefined,
      [ELECTROBUN_BOOT_CONFIG_STORE_KEY]: undefined,
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://fresh.example",
      apiToken: "fresh-token",
    });

    expect(nextConfig).toEqual({
      apiBase: "http://fresh.example",
      apiToken: "fresh-token",
    });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("resynchronizes every location with a fresh copy even when updates are empty", () => {
    const original = {
      apiBase: "http://old.example",
      note: "keep me",
    };
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: original,
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {});

    expect(nextConfig).toEqual({
      apiBase: "http://old.example",
      note: "keep me",
    });
    expect(nextConfig).not.toBe(original);
    expect(original).toEqual({
      apiBase: "http://old.example",
      note: "keep me",
    });
    expect(globalObject.__ELIZA_APP_BOOT_CONFIG__).toBe(nextConfig);
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
  });

  it("replaces prior credentials while preserving unrelated fields", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: {
        apiBase: "http://old.example",
        apiToken: "old-token",
        branding: { name: "Eliza" },
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://new.example",
      apiToken: "new-token",
    });

    expect(nextConfig).toEqual({
      apiBase: "http://new.example",
      apiToken: "new-token",
      branding: { name: "Eliza" },
    });
  });

  it("overwrites a field with an explicit undefined update instead of keeping the old value", () => {
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: {
        apiBase: "http://old.example",
        apiToken: "kept-token",
      },
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: undefined,
    });

    expect(nextConfig.apiBase).toBeUndefined();
    expect("apiBase" in nextConfig).toBe(true);
    expect(nextConfig.apiToken).toBe("kept-token");
  });

  it("retains empty-string values exactly as provided", () => {
    const globalObject: ElectrobunBootConfigWindow = {};

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "",
      apiToken: "",
    });

    expect(nextConfig).toEqual({ apiBase: "", apiToken: "" });
    expect(globalObject.__ELIZAOS_APP_BOOT_CONFIG__).toBe(nextConfig);
  });

  it("replaces a pre-existing store wrapper without mutating the old one", () => {
    const previousStore = { current: { apiBase: "http://old.example" } };
    const globalObject: ElectrobunBootConfigWindow = {
      [ELECTROBUN_BOOT_CONFIG_STORE_KEY]: previousStore,
    };

    const nextConfig = updateElectrobunBootConfig(globalObject, {
      apiBase: "http://new.example",
    });

    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]).not.toBe(
      previousStore,
    );
    expect(globalObject[ELECTROBUN_BOOT_CONFIG_STORE_KEY]?.current).toBe(
      nextConfig,
    );
    expect(previousStore.current).toEqual({ apiBase: "http://old.example" });
  });

  it("does not mutate the config object used as the source", () => {
    const source = {
      apiBase: "http://old.example",
      apiToken: "source-token",
      note: "untouched",
    };
    const globalObject: ElectrobunBootConfigWindow = {
      __ELIZAOS_APP_BOOT_CONFIG__: source,
    };

    updateElectrobunBootConfig(globalObject, {
      apiBase: "http://new.example",
    });

    expect(source).toEqual({
      apiBase: "http://old.example",
      apiToken: "source-token",
      note: "untouched",
    });
  });

  it("registers the store key under the stable global symbol registry", () => {
    expect(ELECTROBUN_BOOT_CONFIG_STORE_KEY).toBe(
      Symbol.for("elizaos.app.boot-config"),
    );
  });
});
