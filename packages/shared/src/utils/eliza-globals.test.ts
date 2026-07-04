import { afterEach, describe, expect, it, vi } from "vitest";
import { getBootConfig, setBootConfig } from "../config/boot-config-store.js";
import {
  clearElizaApiBase,
  clearElizaApiToken,
  getElizaApiBase,
  getElizaApiToken,
  setElizaApiBase,
  setElizaApiToken,
} from "./eliza-globals.js";

declare global {
  interface Window {
    __ELIZAOS_API_BASE__?: string;
    __ELIZA_API_TOKEN__?: string;
    __ELIZAOS_API_TOKEN__?: string;
  }
}

afterEach(() => {
  setBootConfig({ branding: {} });
  vi.unstubAllGlobals();
});

function stubWindow(): Window {
  const windowStub = {};
  vi.stubGlobal("window", windowStub);
  return windowStub as Window;
}

describe("getElizaApiBase", () => {
  it("reads boot config instead of mutable API base globals", () => {
    const windowStub = stubWindow();
    windowStub.__ELIZAOS_API_BASE__ = "https://forged-window.example";

    expect(getElizaApiBase()).toBeUndefined();

    setBootConfig({ branding: {}, apiBase: " https://boot.example " });

    expect(getElizaApiBase()).toBe("https://boot.example");
  });

  it("writes and clears the boot config API base", () => {
    const windowStub = stubWindow();

    setElizaApiBase(" https://api.example ");

    expect(getBootConfig().apiBase).toBe("https://api.example");
    expect(getElizaApiBase()).toBe("https://api.example");
    expect(windowStub.__ELIZAOS_API_BASE__).toBe("https://api.example");

    clearElizaApiBase();

    expect(getBootConfig().apiBase).toBeUndefined();
    expect(getElizaApiBase()).toBeUndefined();
    expect(windowStub.__ELIZAOS_API_BASE__).toBeUndefined();
  });

  it("treats a blank API base as clearing the current value", () => {
    const windowStub = stubWindow();

    setBootConfig({ branding: {}, apiBase: "https://api.example" });
    windowStub.__ELIZAOS_API_BASE__ = "https://api.example";

    setElizaApiBase("   ");

    expect(getElizaApiBase()).toBeUndefined();
    expect(windowStub.__ELIZAOS_API_BASE__).toBeUndefined();
  });
});

describe("getElizaApiToken", () => {
  it("reads boot config instead of mutable token globals", () => {
    const windowStub = stubWindow();
    windowStub.__ELIZA_API_TOKEN__ = "forged-window-token";
    windowStub.__ELIZAOS_API_TOKEN__ = "legacy-window-token";

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
