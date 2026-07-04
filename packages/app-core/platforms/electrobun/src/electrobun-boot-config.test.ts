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
});
