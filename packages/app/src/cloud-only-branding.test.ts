/**
 * Exercises the deterministic pre-render branding resolver with real shared
 * cloud-only policy and literal packaged, hosted, and compatibility inputs.
 */
import {
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "@elizaos/ui/config";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAppCloudOnlyBranding } from "./cloud-only-branding";

afterEach(() => {
  setBootConfig(DEFAULT_BOOT_CONFIG);
});

describe("resolveAppCloudOnlyBranding", () => {
  it("uses the packaged desktop typed boot API base", () => {
    setBootConfig({
      ...DEFAULT_BOOT_CONFIG,
      apiBase: "http://127.0.0.1:56120",
    });

    expect(
      resolveAppCloudOnlyBranding({
        isDev: false,
        bootApiBase: getBootConfig().apiBase,
      }),
    ).toBe(false);
  });

  it("keeps production hosted web cloud-only without an injected backend", () => {
    expect(resolveAppCloudOnlyBranding({ isDev: false })).toBe(true);
  });

  it("preserves the legacy branded-global API-base fallback", () => {
    expect(
      resolveAppCloudOnlyBranding({
        isDev: false,
        legacyInjectedApiBase: "http://127.0.0.1:31337",
      }),
    ).toBe(false);
  });

  it("keeps explicit desktop cloud mode authoritative over a boot API base", () => {
    expect(
      resolveAppCloudOnlyBranding({
        isDev: false,
        bootApiBase: "http://127.0.0.1:31337",
        desktopRuntimeMode: "cloud",
      }),
    ).toBe(true);
  });
});
