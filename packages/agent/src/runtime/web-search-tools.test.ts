/**
 * Covers the server-side web-search injection policy: provider-native search is
 * explicit opt-in via ELIZA_SERVER_WEB_SEARCH, ELIZA_WEB_SEARCH acts as a master
 * kill switch, injection is skipped when the caller already owns tools or
 * structured output, and static SDK function properties are preserved when
 * wrapping the patched call. Deterministic — mutates process.env and builds
 * synthetic function objects; no live provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  __copyStaticFunctionPropertiesForTests,
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

  it("copies static SDK function properties onto patched wrappers", () => {
    const original = Object.assign(
      function originalSdkCall() {
        return "original";
      },
      {
        extra: { enabled: true },
      },
    );
    Object.defineProperty(original, "readOnly", {
      value: "locked",
      writable: false,
      configurable: true,
    });
    Object.defineProperty(original, "computed", {
      get: () => "computed-value",
      configurable: true,
    });
    const wrapped = function wrappedSdkCall() {
      return "wrapped";
    };

    __copyStaticFunctionPropertiesForTests(original, wrapped);

    expect(Reflect.get(wrapped, "extra")).toEqual({ enabled: true });
    expect(Reflect.get(wrapped, "readOnly")).toBe("locked");
    expect(Reflect.get(wrapped, "computed")).toBe("computed-value");
    expect(Object.getOwnPropertyDescriptor(wrapped, "readOnly")?.writable).toBe(
      false,
    );
  });
});
