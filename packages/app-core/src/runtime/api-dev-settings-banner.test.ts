/** Verifies that the full API settings banner remains opt-in during dev startup. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { shouldShowApiDevSettingsBanner } from "./api-dev-settings-banner";

describe("shouldShowApiDevSettingsBanner", () => {
  it("keeps the default info-level startup compact", () => {
    expect(shouldShowApiDevSettingsBanner({ LOG_LEVEL: "info" })).toBe(false);
    expect(shouldShowApiDevSettingsBanner({})).toBe(false);
  });

  it.each([
    { ELIZA_DEV_SHOW_SETTINGS: "1" },
    { ELIZA_DEV_VERBOSE_LOGS: "1" },
    { ELIZA_DEV_LOG_LEVEL: "debug" },
    { LOG_LEVEL: "trace" },
    { ELIZA_SETTINGS_DEBUG: "true" },
  ] satisfies Array<Record<string, string | undefined>>)(
    "shows diagnostics for an explicit verbose/debug setting",
    (env) => {
      expect(shouldShowApiDevSettingsBanner(env)).toBe(true);
    },
  );

  it("does not treat explicit false values as verbose", () => {
    expect(
      shouldShowApiDevSettingsBanner({
        ELIZA_DEV_SHOW_SETTINGS: "0",
        ELIZA_DEV_VERBOSE_LOGS: "0",
        ELIZA_SETTINGS_DEBUG: "false",
        LOG_LEVEL: "info",
      }),
    ).toBe(false);
  });
});

describe("dev-server startup output", () => {
  const source = readFileSync(
    new URL("./dev-server.ts", import.meta.url),
    "utf8",
  );

  it("loads dotenv without promotional tips", () => {
    expect(source).toContain("loadDotenv({ quiet: true });");
  });

  it("uses one compact app-core readiness line instead of the box", () => {
    expect(source).toContain("API ready: http://localhost:");
    expect(source).not.toContain("Server is running.");
    expect(source).not.toContain("Connect at: http://localhost:");
  });
});
