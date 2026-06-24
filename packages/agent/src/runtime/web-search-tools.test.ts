import { afterEach, describe, expect, it } from "vitest";
import {
  __shouldSkipServerSideWebSearchForTests,
  isServerSideWebSearchEnabled,
} from "./web-search-tools";

describe("server-side web search injection policy", () => {
  const originalMaster = process.env.ELIZA_WEB_SEARCH;
  const originalServer = process.env.ELIZA_SERVER_WEB_SEARCH;

  afterEach(() => {
    if (originalMaster === undefined) delete process.env.ELIZA_WEB_SEARCH;
    else process.env.ELIZA_WEB_SEARCH = originalMaster;
    if (originalServer === undefined)
      delete process.env.ELIZA_SERVER_WEB_SEARCH;
    else process.env.ELIZA_SERVER_WEB_SEARCH = originalServer;
  });

  it("is explicit opt-in by default", () => {
    delete process.env.ELIZA_WEB_SEARCH;
    delete process.env.ELIZA_SERVER_WEB_SEARCH;
    expect(isServerSideWebSearchEnabled()).toBe(false);
  });

  it("enables provider-native injection only through ELIZA_SERVER_WEB_SEARCH", () => {
    process.env.ELIZA_SERVER_WEB_SEARCH = "1";
    expect(isServerSideWebSearchEnabled()).toBe(true);
  });

  it("honors ELIZA_WEB_SEARCH as a master kill switch", () => {
    process.env.ELIZA_SERVER_WEB_SEARCH = "1";
    for (const value of ["0", "false", "off", "no"]) {
      process.env.ELIZA_WEB_SEARCH = value;
      expect(isServerSideWebSearchEnabled()).toBe(false);
    }
  });

  it("skips injection when the caller owns tools or structured output", () => {
    expect(
      __shouldSkipServerSideWebSearchForTests({ tools: { local: {} } }),
    ).toBe(true);
    expect(__shouldSkipServerSideWebSearchForTests({ output: "object" })).toBe(
      true,
    );
    expect(
      __shouldSkipServerSideWebSearchForTests({
        responseFormat: { type: "json" },
      }),
    ).toBe(true);
    expect(
      __shouldSkipServerSideWebSearchForTests({
        responseFormat: { type: "text" },
      }),
    ).toBe(false);
  });
});
