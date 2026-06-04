// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { injectPopoutApiBase } from "./init";

describe("platform init waifu chat access bootstrap", () => {
  beforeEach(() => {
    if (typeof window === "undefined") {
      const dom = new JSDOM("<!doctype html><html><body></body></html>", {
        url: "http://localhost/",
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        history: dom.window.history,
        location: dom.window.location,
        navigator: dom.window.navigator,
      });
    }
    setBootConfig({ branding: {}, apiToken: "existing-token" });
    window.history.replaceState(null, "", "/");
  });

  it("moves waifu_access_token from the hosted chat URL into the API bearer token", () => {
    window.history.replaceState(
      null,
      "",
      "/chat?waifu_access_token=jwt-token&tab=chat",
    );

    injectPopoutApiBase();

    expect(getBootConfig().apiToken).toBe("jwt-token");
    expect(window.location.href).toBe(`${window.location.origin}/chat?tab=chat`);
  });

  it("preserves existing boot config while replacing only the API token", () => {
    setBootConfig({
      branding: { appName: "Eliza Cloud Agent" },
      apiBase: "/api",
      apiToken: "old-token",
    });
    window.history.replaceState(
      null,
      "",
      "/#/chat?waifu_access_token=fresh-token",
    );

    injectPopoutApiBase();

    expect(getBootConfig()).toMatchObject({
      branding: { appName: "Eliza Cloud Agent" },
      apiBase: "/api",
      apiToken: "fresh-token",
    });
    expect(window.location.href).toBe(`${window.location.origin}/#/chat`);
  });
});
