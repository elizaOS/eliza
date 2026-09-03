/**
 * Permission, scripting and dynamic-rule facades in the browser API wrapper.
 *
 * These decide whether the extension believes it may read a page, inject code,
 * or rewrite network requests. The property that matters most is what they do
 * when the underlying browser API is *absent*: a check that guessed `true`
 * there would hand the caller access it was never granted.
 *
 * Deterministic: `chrome` is stubbed per test with only the surface each case
 * needs, so an accidental reach for another API throws rather than passing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeContentScriptFiles,
  executeScriptInMainWorld,
  getDynamicRules,
  getExtensionUrl,
  getGrantedOrigins,
  hasAllUrlHostPermission,
  hasManifestPermission,
  hasWebsiteAccess,
  isIncognitoAccessAllowed,
  requestAllWebsiteAccess,
  requestWebsiteAccess,
  updateDynamicRules,
} from "./webextension";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A stub whose only guaranteed member is `runtime`, so reaches are visible. */
function stubChrome(api: Record<string, unknown>): void {
  vi.stubGlobal("chrome", { runtime: {}, ...api });
}

describe("permission checks fail CLOSED when the API is missing", () => {
  it("hasAllUrlHostPermission is false without permissions.contains", async () => {
    stubChrome({ permissions: {} });
    await expect(hasAllUrlHostPermission()).resolves.toBe(false);
  });

  it("hasWebsiteAccess is false without permissions.contains", async () => {
    stubChrome({ permissions: {} });
    await expect(hasWebsiteAccess("https://example.com/*")).resolves.toBe(
      false,
    );
  });

  it("isIncognitoAccessAllowed is false without the extension API", async () => {
    stubChrome({ extension: {} });
    await expect(isIncognitoAccessAllowed()).resolves.toBe(false);
  });

  it("getGrantedOrigins is empty without permissions.getAll", async () => {
    stubChrome({ permissions: {} });
    await expect(getGrantedOrigins()).resolves.toEqual([]);
  });

  it("getDynamicRules is empty without the declarativeNetRequest API", async () => {
    stubChrome({ declarativeNetRequest: {} });
    await expect(getDynamicRules()).resolves.toEqual([]);
  });

  it("hasManifestPermission is false without a manifest", () => {
    stubChrome({});
    expect(hasManifestPermission("scripting")).toBe(false);
  });
});

describe("permission REQUESTS refuse loudly instead of reporting a denial", () => {
  // A silent `false` here is indistinguishable from the user clicking Deny,
  // which would send a caller down a "user refused" path when the truth is a
  // broken runtime.
  it("requestAllWebsiteAccess throws without permissions.request", async () => {
    stubChrome({ permissions: {} });
    await expect(requestAllWebsiteAccess()).rejects.toThrow(
      /permissions\.request is unavailable/,
    );
  });

  it("requestWebsiteAccess throws without permissions.request", async () => {
    stubChrome({ permissions: {} });
    await expect(requestWebsiteAccess("https://example.com/*")).rejects.toThrow(
      /permissions\.request is unavailable/,
    );
  });

  it("script injection throws rather than silently doing nothing", async () => {
    stubChrome({ scripting: {} });
    await expect(executeScriptInMainWorld(1, () => 1)).rejects.toThrow(
      /scripting\.executeScript is unavailable/,
    );
    await expect(executeContentScriptFiles(1, ["a.js"])).rejects.toThrow(
      /scripting\.executeScript is unavailable/,
    );
  });
});

describe("the exact origin patterns asked for", () => {
  it("hasAllUrlHostPermission asks for http and https only, not <all_urls>", async () => {
    // `<all_urls>` would additionally cover file:// and ftp://. Asking for the
    // two schemes explicitly is what keeps the grant to normal web pages.
    const contains = vi.fn((_query: unknown, callback: (v: boolean) => void) =>
      callback(true),
    );
    stubChrome({ permissions: { contains } });

    await expect(hasAllUrlHostPermission()).resolves.toBe(true);
    expect(contains.mock.calls[0]?.[0]).toEqual({
      origins: ["https://*/*", "http://*/*"],
    });
  });

  it("hasWebsiteAccess asks for exactly the pattern it was given", async () => {
    const contains = vi.fn((_query: unknown, callback: (v: boolean) => void) =>
      callback(false),
    );
    stubChrome({ permissions: { contains } });

    await expect(hasWebsiteAccess("https://example.com/*")).resolves.toBe(
      false,
    );
    expect(contains.mock.calls[0]?.[0]).toEqual({
      origins: ["https://example.com/*"],
    });
  });
});

describe("a denied request is re-checked against what is actually held", () => {
  // Chrome can answer `false` to permissions.request while the permission is
  // in fact already granted. Trusting that answer would make the extension
  // re-prompt forever, or report no access it demonstrably has.
  it("requestAllWebsiteAccess returns true when the grant is already held", async () => {
    const request = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(false),
    );
    const contains = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(true),
    );
    stubChrome({ permissions: { request, contains } });

    await expect(requestAllWebsiteAccess()).resolves.toBe(true);
    expect(contains).toHaveBeenCalledTimes(1);
  });

  it("requestWebsiteAccess returns true when that origin is already held", async () => {
    const request = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(false),
    );
    const contains = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(true),
    );
    stubChrome({ permissions: { request, contains } });

    await expect(requestWebsiteAccess("https://example.com/*")).resolves.toBe(
      true,
    );
    expect(contains.mock.calls[0]?.[0]).toEqual({
      origins: ["https://example.com/*"],
    });
  });

  it("does NOT re-check when the request already succeeded", async () => {
    const request = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(true),
    );
    const contains = vi.fn();
    stubChrome({ permissions: { request, contains } });

    await expect(requestAllWebsiteAccess()).resolves.toBe(true);
    expect(contains).not.toHaveBeenCalled();
  });

  it("reports false when neither the request nor the held check succeeds", async () => {
    const request = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(false),
    );
    const contains = vi.fn((_q: unknown, callback: (v: boolean) => void) =>
      callback(false),
    );
    stubChrome({ permissions: { request, contains } });

    await expect(requestAllWebsiteAccess()).resolves.toBe(false);
    await expect(requestWebsiteAccess("https://example.com/*")).resolves.toBe(
      false,
    );
  });
});

describe("getGrantedOrigins normalizes what the browser reports", () => {
  function withOrigins(origins: unknown): void {
    stubChrome({
      permissions: {
        getAll: (callback: (v: unknown) => void) => callback({ origins }),
      },
    });
  }

  it("trims, drops blanks and non-strings, and sorts", async () => {
    withOrigins([
      "  https://z.example/*  ",
      42,
      "https://a.example/*",
      "   ",
      null,
      "",
    ]);
    await expect(getGrantedOrigins()).resolves.toEqual([
      "https://a.example/*",
      "https://z.example/*",
    ]);
  });

  it("returns an empty list when origins is absent or not an array", async () => {
    for (const value of [undefined, null, "https://example.com/*", {}]) {
      withOrigins(value);
      await expect(getGrantedOrigins()).resolves.toEqual([]);
    }
  });

  it("keeps duplicates rather than inventing a de-duplication rule", async () => {
    // The browser is the source of truth for this list; silently collapsing it
    // would hide a real duplicate-grant condition from a caller comparing sets.
    withOrigins(["https://a.example/*", "https://a.example/*"]);
    await expect(getGrantedOrigins()).resolves.toEqual([
      "https://a.example/*",
      "https://a.example/*",
    ]);
  });
});

describe("script injection targets the right world", () => {
  it("executeScriptInMainWorld runs in MAIN and returns the first frame result", async () => {
    const executeScript = vi.fn(
      (_injection: unknown, callback: (v: unknown[]) => void) =>
        callback([{ result: "from-page" }, { result: "from-iframe" }]),
    );
    stubChrome({ scripting: { executeScript } });

    await expect(executeScriptInMainWorld(7, () => "x")).resolves.toBe(
      "from-page",
    );
    const injection = executeScript.mock.calls[0]?.[0] as {
      world: string;
      target: { tabId: number };
      args: unknown[];
    };
    expect(injection.world).toBe("MAIN");
    expect(injection.target).toEqual({ tabId: 7 });
    expect(injection.args).toEqual([]);
  });

  it("forwards args and tolerates an empty result set", async () => {
    const executeScript = vi.fn(
      (_injection: unknown, callback: (v: unknown[]) => void) => callback([]),
    );
    stubChrome({ scripting: { executeScript } });

    await expect(
      executeScriptInMainWorld(7, (a) => a, ["alpha", 1]),
    ).resolves.toBeUndefined();
    const injection = executeScript.mock.calls[0]?.[0] as { args: unknown[] };
    expect(injection.args).toEqual(["alpha", 1]);
  });

  it("executeContentScriptFiles runs ISOLATED, never in the page world", async () => {
    // MAIN would expose the injected file to page JavaScript and to anything
    // the page has already patched onto its own globals.
    const executeScript = vi.fn(
      (_injection: unknown, callback: (v: unknown[]) => void) => callback([]),
    );
    stubChrome({ scripting: { executeScript } });

    await executeContentScriptFiles(9, ["content.js", "extra.js"]);
    const injection = executeScript.mock.calls[0]?.[0] as {
      world: string;
      files: string[];
      target: { tabId: number };
      func?: unknown;
    };
    expect(injection.world).toBe("ISOLATED");
    expect(injection.files).toEqual(["content.js", "extra.js"]);
    expect(injection.target).toEqual({ tabId: 9 });
    expect(injection.func).toBeUndefined();
  });
});

describe("dynamic network rules", () => {
  it("passes the update through unchanged", async () => {
    const updateDynamicRulesSpy = vi.fn(
      (_options: unknown, callback: () => void) => callback(),
    );
    stubChrome({
      declarativeNetRequest: { updateDynamicRules: updateDynamicRulesSpy },
    });

    const options = {
      removeRuleIds: [1, 2],
      addRules: [{ id: 3 }] as never,
    };
    await updateDynamicRules(options);
    expect(updateDynamicRulesSpy.mock.calls[0]?.[0]).toEqual(options);
  });

  it("is a no-op, not a throw, when the API is missing", async () => {
    // Rule updates run on startup paths; a throw there would take down the
    // worker on a browser that does not expose declarativeNetRequest.
    stubChrome({ declarativeNetRequest: {} });
    await expect(
      updateDynamicRules({ removeRuleIds: [1] }),
    ).resolves.toBeUndefined();
  });

  it("returns the rules the browser reports", async () => {
    stubChrome({
      declarativeNetRequest: {
        getDynamicRules: (callback: (v: unknown[]) => void) =>
          callback([{ id: 1 }, { id: 2 }]),
      },
    });
    await expect(getDynamicRules()).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("getExtensionUrl", () => {
  it("resolves through runtime.getURL when available", () => {
    stubChrome({
      runtime: { getURL: (path: string) => `chrome-extension://id/${path}` },
    });
    expect(getExtensionUrl("popup.html")).toBe(
      "chrome-extension://id/popup.html",
    );
  });

  it("falls back to the raw path rather than throwing", () => {
    stubChrome({});
    expect(getExtensionUrl("popup.html")).toBe("popup.html");
  });
});
