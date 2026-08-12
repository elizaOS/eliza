/**
 * Unit coverage for bridging plugin Settings values into runtime.setSetting
 * so connector plugins can observe credentials via getSetting without a full
 * process restart. Deterministic mocks only — no live Discord/Telegram.
 */
import { describe, expect, it, vi } from "vitest";
import { bridgePluginParamsToRuntime } from "./bridge-plugin-settings.ts";

describe("bridgePluginParamsToRuntime", () => {
  it("writes trimmed values through setSetting with sensitive flag", () => {
    const setSetting = vi.fn();
    bridgePluginParamsToRuntime(
      { setSetting },
      [{ key: "DISCORD_API_TOKEN", sensitive: true }],
      { DISCORD_API_TOKEN: "  abc123  " },
    );
    expect(setSetting).toHaveBeenCalledWith(
      "DISCORD_API_TOKEN",
      "abc123",
      true,
    );
  });

  it("clears blank submitted values with null", () => {
    const setSetting = vi.fn();
    bridgePluginParamsToRuntime(
      { setSetting },
      [{ key: "DISCORD_APPLICATION_ID", sensitive: false }],
      { DISCORD_APPLICATION_ID: "   " },
    );
    expect(setSetting).toHaveBeenCalledWith(
      "DISCORD_APPLICATION_ID",
      null,
      false,
    );
  });

  it("hydrates from process.env when values map is omitted", () => {
    const previous = process.env.DISCORD_API_TOKEN;
    process.env.DISCORD_API_TOKEN = "from-env";
    try {
      const setSetting = vi.fn();
      bridgePluginParamsToRuntime(
        { setSetting },
        [{ key: "DISCORD_API_TOKEN", sensitive: true }],
      );
      expect(setSetting).toHaveBeenCalledWith(
        "DISCORD_API_TOKEN",
        "from-env",
        true,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.DISCORD_API_TOKEN;
      } else {
        process.env.DISCORD_API_TOKEN = previous;
      }
    }
  });

  it("is a no-op without a runtime setSetting", () => {
    expect(() =>
      bridgePluginParamsToRuntime(null, [
        { key: "DISCORD_API_TOKEN", sensitive: true },
      ], { DISCORD_API_TOKEN: "x" }),
    ).not.toThrow();
  });
});
