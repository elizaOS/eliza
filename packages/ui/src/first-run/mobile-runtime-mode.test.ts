// @vitest-environment jsdom

/**
 * Unit coverage for persisting the mobile runtime mode (including the
 * server-target derivation). Capacitor Preferences + native detection mocked,
 * no real device.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IOS_LOCAL_AGENT_IPC_BASE,
  isCommittedOnDeviceMobileRuntimeMode,
  isElizaCloudRuntimeLocked,
  isMobileLocalAgentIpcBase,
  isMobileLocalAgentIpcUrl,
  isMobileLocalAgentUrl,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_LOCAL_AGENT_IPC_BASE,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  mobileLocalAgentPathFromUrl,
  mobileRuntimeModeForServerTarget,
  normalizeMobileRuntimeMode,
  persistMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

const { capacitorState, preferencesRemoveMock, preferencesSetMock } =
  vi.hoisted(() => ({
    capacitorState: { isNative: true },
    preferencesRemoveMock: vi.fn(async () => undefined),
    preferencesSetMock: vi.fn(async () => undefined),
  }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    remove: preferencesRemoveMock,
    set: preferencesSetMock,
  },
}));

describe("persistMobileRuntimeModeForServerTarget", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    capacitorState.isNative = true;
  });

  it("persists local mode to localStorage and Capacitor Preferences", async () => {
    persistMobileRuntimeModeForServerTarget("local");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    });
  });

  it("removes the native preference when the target has no mobile mode", async () => {
    persistMobileRuntimeModeForServerTarget("");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      null,
    );
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      });
    });
  });
});

describe("persistMobileRuntimeMode (single write path)", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    capacitorState.isNative = true;
  });

  it("persists a direct mode write to both stores (used by boot reconciliation, #11030)", async () => {
    persistMobileRuntimeMode("local");

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      "local",
    );
    await vi.waitFor(() => {
      expect(preferencesSetMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: "local",
      });
    });
  });

  it("clears both stores when passed null", async () => {
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");

    persistMobileRuntimeMode(null);

    expect(window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBe(
      null,
    );
    await vi.waitFor(() => {
      expect(preferencesRemoveMock).toHaveBeenCalledWith({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
      });
    });
  });
});

describe("isMobileLocalAgentIpcUrl", () => {
  it("matches the IPC base and its path/query variants", () => {
    expect(isMobileLocalAgentIpcUrl(MOBILE_LOCAL_AGENT_IPC_BASE)).toBe(true);
    expect(
      isMobileLocalAgentIpcUrl(`${MOBILE_LOCAL_AGENT_IPC_BASE}/api/status`),
    ).toBe(true);
    expect(
      isMobileLocalAgentIpcUrl(`${MOBILE_LOCAL_AGENT_IPC_BASE}?foo=1`),
    ).toBe(true);
    // Chromium WebView reshapes the authority into a `//ipc/...` pathname.
    expect(
      isMobileLocalAgentIpcUrl(new URL(`${MOBILE_LOCAL_AGENT_IPC_BASE}/api`)),
    ).toBe(true);
  });

  it("rejects empty, loopback-http, and unparseable values", () => {
    expect(isMobileLocalAgentIpcUrl(null)).toBe(false);
    expect(isMobileLocalAgentIpcUrl("   ")).toBe(false);
    expect(isMobileLocalAgentIpcUrl(MOBILE_LOCAL_AGENT_API_BASE)).toBe(false);
    expect(isMobileLocalAgentIpcUrl("https://example.test")).toBe(false);
    expect(isMobileLocalAgentIpcUrl("::not a url::")).toBe(false);
  });
});

describe("isMobileLocalAgentIpcBase", () => {
  it("matches the IPC base with or without a trailing slash", () => {
    expect(isMobileLocalAgentIpcBase(MOBILE_LOCAL_AGENT_IPC_BASE)).toBe(true);
    expect(isMobileLocalAgentIpcBase(`${MOBILE_LOCAL_AGENT_IPC_BASE}/`)).toBe(
      true,
    );
  });
  it("rejects a null/absent base and unrelated hosts", () => {
    expect(isMobileLocalAgentIpcBase(null)).toBe(false);
    expect(isMobileLocalAgentIpcBase("https://api.elizacloud.ai")).toBe(false);
  });
});

describe("mobileLocalAgentPathFromUrl", () => {
  it("extracts the request path from IPC and loopback-http forms", () => {
    expect(mobileLocalAgentPathFromUrl(MOBILE_LOCAL_AGENT_IPC_BASE)).toBe("/");
    expect(
      mobileLocalAgentPathFromUrl(`${MOBILE_LOCAL_AGENT_IPC_BASE}/api/health`),
    ).toBe("/api/health");
    expect(
      mobileLocalAgentPathFromUrl(`${MOBILE_LOCAL_AGENT_IPC_BASE}?x=1`),
    ).toBe("/?x=1");
    expect(
      mobileLocalAgentPathFromUrl(`${MOBILE_LOCAL_AGENT_API_BASE}/api/status`),
    ).toBe("/api/status");
  });
  it("returns null for absent, unparseable, and non-local URLs", () => {
    expect(mobileLocalAgentPathFromUrl(null)).toBeNull();
    expect(mobileLocalAgentPathFromUrl("   ")).toBeNull();
    expect(mobileLocalAgentPathFromUrl("::nope::")).toBeNull();
    expect(mobileLocalAgentPathFromUrl("https://example.test/api")).toBeNull();
  });
});

describe("isMobileLocalAgentUrl", () => {
  it("accepts the IPC identity and the loopback-http implementation base", () => {
    expect(isMobileLocalAgentUrl(IOS_LOCAL_AGENT_IPC_BASE)).toBe(true);
    expect(isMobileLocalAgentUrl(`${MOBILE_LOCAL_AGENT_API_BASE}/api`)).toBe(
      true,
    );
  });
  it("rejects remote hosts and junk", () => {
    expect(isMobileLocalAgentUrl(null)).toBe(false);
    expect(isMobileLocalAgentUrl("https://example.test")).toBe(false);
    expect(isMobileLocalAgentUrl("::bad::")).toBe(false);
  });
});

describe("normalizeMobileRuntimeMode", () => {
  it("passes through every known mode (trimming) and rejects the rest", () => {
    for (const mode of [
      "remote-mac",
      "cloud",
      "cloud-hybrid",
      "local",
      "tunnel-to-mobile",
    ] as const) {
      expect(normalizeMobileRuntimeMode(mode)).toBe(mode);
      expect(normalizeMobileRuntimeMode(` ${mode} `)).toBe(mode);
    }
    expect(normalizeMobileRuntimeMode(null)).toBeNull();
    expect(normalizeMobileRuntimeMode("")).toBeNull();
    expect(normalizeMobileRuntimeMode("external")).toBeNull();
  });
});

describe("mobileRuntimeModeForServerTarget", () => {
  it("maps first-run server targets to their runtime mode", () => {
    expect(mobileRuntimeModeForServerTarget("remote")).toBe("remote-mac");
    expect(mobileRuntimeModeForServerTarget("elizacloud")).toBe("cloud");
    expect(mobileRuntimeModeForServerTarget("elizacloud-hybrid")).toBe(
      "cloud-hybrid",
    );
    expect(mobileRuntimeModeForServerTarget("local")).toBe("local");
  });
});

describe("isCommittedOnDeviceMobileRuntimeMode", () => {
  it("is true only for the on-device-agent modes (local + cloud-hybrid)", () => {
    expect(isCommittedOnDeviceMobileRuntimeMode("local")).toBe(true);
    expect(isCommittedOnDeviceMobileRuntimeMode("cloud-hybrid")).toBe(true);
    expect(isCommittedOnDeviceMobileRuntimeMode("cloud")).toBe(false);
    expect(isCommittedOnDeviceMobileRuntimeMode("remote-mac")).toBe(false);
    expect(isCommittedOnDeviceMobileRuntimeMode("tunnel-to-mobile")).toBe(
      false,
    );
    expect(isCommittedOnDeviceMobileRuntimeMode(null)).toBe(false);
  });
});

describe("read + isElizaCloudRuntimeLocked", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("reads null when nothing (or garbage) is persisted", () => {
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "external");
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });

  it("reads the persisted mode back", () => {
    window.localStorage.setItem(
      MOBILE_RUNTIME_MODE_STORAGE_KEY,
      "cloud-hybrid",
    );
    expect(readPersistedMobileRuntimeMode()).toBe("cloud-hybrid");
  });

  it("locks the Eliza Cloud runtime for cloud + cloud-hybrid, not local/none", () => {
    expect(isElizaCloudRuntimeLocked()).toBe(false);
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "cloud");
    expect(isElizaCloudRuntimeLocked()).toBe(true);
    window.localStorage.setItem(
      MOBILE_RUNTIME_MODE_STORAGE_KEY,
      "cloud-hybrid",
    );
    expect(isElizaCloudRuntimeLocked()).toBe(true);
    window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, "local");
    expect(isElizaCloudRuntimeLocked()).toBe(false);
  });
});
