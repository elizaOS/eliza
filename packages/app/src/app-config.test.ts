/** Verifies deterministic pre-React desktop API-base selection without a host runtime. */

import { describe, expect, it } from "vitest";
import {
  resolveDesktopHostBootConfig,
  resolveInjectedAppApiBase,
} from "./app-config";

describe("resolveInjectedAppApiBase", () => {
  it("uses the canonical injected boot config for packaged local desktop", () => {
    expect(
      resolveInjectedAppApiBase({
        bootConfigApiBase: "http://127.0.0.1:32437",
      }),
    ).toBe("http://127.0.0.1:32437");
  });

  it("keeps legacy host globals as compatibility fallbacks", () => {
    expect(
      resolveInjectedAppApiBase({
        legacyApiBase: "https://legacy.example",
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("https://legacy.example");
    expect(
      resolveInjectedAppApiBase({
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("https://brand.example");
  });

  it("prefers canonical boot config over compatibility globals", () => {
    expect(
      resolveInjectedAppApiBase({
        bootConfigApiBase: "http://127.0.0.1:32437",
        legacyApiBase: "https://legacy.example",
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("http://127.0.0.1:32437");
  });
});

describe("resolveDesktopHostBootConfig", () => {
  it("accepts a complete native URL capability", () => {
    expect(
      resolveDesktopHostBootConfig(
        "?elizaDesktopPlatform=darwin&elizaDesktopSurface=bottom-bar",
      ),
    ).toEqual({ platform: "darwin", surface: "bottom-bar" });
  });

  it("fails closed for incomplete or unknown host identity", () => {
    expect(
      resolveDesktopHostBootConfig("?elizaDesktopPlatform=darwin"),
    ).toBeUndefined();
    expect(
      resolveDesktopHostBootConfig(
        "?elizaDesktopPlatform=ios&elizaDesktopSurface=bottom-bar",
      ),
    ).toBeUndefined();
  });

  it("prefers the typed injected host over URL parameters", () => {
    expect(
      resolveDesktopHostBootConfig(
        "?elizaDesktopPlatform=win32&elizaDesktopSurface=default",
        { platform: "darwin", surface: "bottom-bar" },
      ),
    ).toEqual({ platform: "darwin", surface: "bottom-bar" });
  });
});
