/**
 * Unit coverage for folding plugin Settings values into runtime.setSetting
 * so connector plugins can observe credentials via getSetting without a full
 * process restart. Deterministic mocks only — no live Discord/Telegram.
 */
import { describe, expect, it, vi } from "vitest";
import {
  bridgePluginParamsToRuntime,
  clearPluginParamValues,
  collectAgentScopedPluginParamValues,
} from "./bridge-plugin-settings.ts";

describe("collectAgentScopedPluginParamValues", () => {
  it("prefers entry.config over config.env and skips blanks", () => {
    expect(
      collectAgentScopedPluginParamValues(
        [
          { key: "DISCORD_API_TOKEN", sensitive: true },
          { key: "DISCORD_APPLICATION_ID", sensitive: false },
          { key: "MISSING", sensitive: false },
        ],
        {
          entryConfig: { DISCORD_API_TOKEN: " from-entry " },
          configEnv: {
            DISCORD_API_TOKEN: "from-env",
            DISCORD_APPLICATION_ID: "app-id",
            MISSING: "   ",
          },
        },
      ),
    ).toEqual({
      DISCORD_API_TOKEN: "from-entry",
      DISCORD_APPLICATION_ID: "app-id",
    });
  });
});

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

  it("skips non-empty writes for blocked keys but still clears them", () => {
    const setSetting = vi.fn();
    const isBlockedKey = (key: string) => key === "ELIZA_API_TOKEN";
    bridgePluginParamsToRuntime(
      { setSetting },
      [
        { key: "ELIZA_API_TOKEN", sensitive: true },
        { key: "DISCORD_API_TOKEN", sensitive: true },
      ],
      {
        ELIZA_API_TOKEN: "host-token",
        DISCORD_API_TOKEN: "bot-token",
      },
      { isBlockedKey },
    );
    expect(setSetting).toHaveBeenCalledTimes(1);
    expect(setSetting).toHaveBeenCalledWith(
      "DISCORD_API_TOKEN",
      "bot-token",
      true,
    );

    setSetting.mockClear();
    bridgePluginParamsToRuntime(
      { setSetting },
      [{ key: "ELIZA_API_TOKEN", sensitive: true }],
      clearPluginParamValues([{ key: "ELIZA_API_TOKEN", sensitive: true }]),
      { isBlockedKey },
    );
    expect(setSetting).toHaveBeenCalledWith("ELIZA_API_TOKEN", null, true);
  });

  it("is a no-op without a runtime setSetting", () => {
    expect(() =>
      bridgePluginParamsToRuntime(
        null,
        [{ key: "DISCORD_API_TOKEN", sensitive: true }],
        { DISCORD_API_TOKEN: "x" },
      ),
    ).not.toThrow();
  });
});
