import { afterEach, describe, expect, it } from "vitest";
import { setBootConfig } from "../config/boot-config-store.js";
import {
  clearElizaApiToken,
  getElizaApiToken,
  setElizaApiToken,
} from "./eliza-globals.js";

declare global {
  interface Window {
    __ELIZA_API_TOKEN__?: string;
    __ELIZAOS_API_TOKEN__?: string;
  }
}

afterEach(() => {
  setBootConfig({ branding: {} });
  if (typeof window !== "undefined") {
    Reflect.deleteProperty(window, "__ELIZA_API_TOKEN__");
    Reflect.deleteProperty(window, "__ELIZAOS_API_TOKEN__");
  }
});

describe("getElizaApiToken", () => {
  it("reads boot config instead of mutable token globals", () => {
    if (typeof window !== "undefined") {
      window.__ELIZA_API_TOKEN__ = "forged-window-token";
      window.__ELIZAOS_API_TOKEN__ = "legacy-window-token";
    }

    expect(getElizaApiToken()).toBeUndefined();

    setBootConfig({ branding: {}, apiToken: " boot-token " });

    expect(getElizaApiToken()).toBe("boot-token");
  });

  it("writes and clears the boot config token", () => {
    setElizaApiToken(" next-token ");

    expect(getElizaApiToken()).toBe("next-token");

    clearElizaApiToken();

    expect(getElizaApiToken()).toBeUndefined();
  });
});
