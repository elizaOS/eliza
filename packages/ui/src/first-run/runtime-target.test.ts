/** Verifies first-run runtime-target resolution against the real boot-config store. */
// @vitest-environment node

/**
 * Covers `resolveFirstRunLocalAgentApiBase` platform precedence (iOS > Android >
 * configured Eliza API base > loopback default), the cloud-target predicate, and
 * the active-server-kind → first-run-target mapping (the non-obvious
 * `cloud → elizacloud` rename). The platform constants are the only seam
 * substituted — detection is an import-time Capacitor probe that cannot fire in
 * a test process — while the API-base path runs through the REAL
 * `setElizaApiBase`/`clearElizaApiBase` boot-config store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TestPlatform = { isIOS: boolean; isAndroid: boolean };
type GlobalWithTestPlatform = typeof globalThis & {
  __runtimeTargetTestPlatform?: TestPlatform;
};

vi.mock("../platform/init", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/init")>();
  return {
    ...actual,
    get isIOS() {
      return (
        (globalThis as GlobalWithTestPlatform).__runtimeTargetTestPlatform
          ?.isIOS ?? false
      );
    },
    get isAndroid() {
      return (
        (globalThis as GlobalWithTestPlatform).__runtimeTargetTestPlatform
          ?.isAndroid ?? false
      );
    },
  };
});

import { clearElizaApiBase, setElizaApiBase } from "../utils";
import {
  activeServerKindToFirstRunRuntimeTarget,
  isElizaCloudFirstRunTarget,
  resolveFirstRunLocalAgentApiBase,
} from "./runtime-target";

function setTestPlatform(platform: TestPlatform): void {
  (globalThis as GlobalWithTestPlatform).__runtimeTargetTestPlatform = platform;
}

beforeEach(() => {
  clearElizaApiBase();
  setTestPlatform({ isIOS: false, isAndroid: false });
});

afterEach(() => {
  clearElizaApiBase();
  delete (globalThis as GlobalWithTestPlatform).__runtimeTargetTestPlatform;
});

describe("resolveFirstRunLocalAgentApiBase", () => {
  it("returns the iOS IPC base when iOS wins over Android", () => {
    setTestPlatform({ isIOS: true, isAndroid: true });
    expect(resolveFirstRunLocalAgentApiBase()).toBe("eliza-local-agent://ipc");
  });

  it("returns the iOS IPC base on iOS alone", () => {
    setTestPlatform({ isIOS: true, isAndroid: false });
    expect(resolveFirstRunLocalAgentApiBase()).toBe("eliza-local-agent://ipc");
  });

  it("returns the Android IPC base when only Android is detected", () => {
    setTestPlatform({ isIOS: false, isAndroid: true });
    expect(resolveFirstRunLocalAgentApiBase()).toBe("eliza-local-agent://ipc");
  });

  it("returns the configured Eliza API base on desktop/web", () => {
    setElizaApiBase("http://192.168.1.10:4545");
    expect(resolveFirstRunLocalAgentApiBase()).toBe("http://192.168.1.10:4545");
  });

  it("falls back to the loopback default when no API base is configured", () => {
    expect(resolveFirstRunLocalAgentApiBase()).toBe("http://127.0.0.1:31337");
  });

  it("treats a whitespace-only API base as unconfigured", () => {
    setElizaApiBase("   ");
    expect(resolveFirstRunLocalAgentApiBase()).toBe("http://127.0.0.1:31337");
  });

  it("ignores a stale configured API base on native mobile", () => {
    setElizaApiBase("http://192.168.1.10:4545");
    setTestPlatform({ isIOS: false, isAndroid: true });
    expect(resolveFirstRunLocalAgentApiBase()).toBe("eliza-local-agent://ipc");
  });
});

describe("isElizaCloudFirstRunTarget", () => {
  it("is true only for the elizacloud targets", () => {
    expect(isElizaCloudFirstRunTarget("elizacloud")).toBe(true);
    expect(isElizaCloudFirstRunTarget("elizacloud-hybrid")).toBe(true);
    expect(isElizaCloudFirstRunTarget("local")).toBe(false);
    expect(isElizaCloudFirstRunTarget("remote")).toBe(false);
    expect(isElizaCloudFirstRunTarget("")).toBe(false);
  });
});

describe("activeServerKindToFirstRunRuntimeTarget", () => {
  it("maps each server kind to its first-run target", () => {
    expect(activeServerKindToFirstRunRuntimeTarget("local")).toBe("local");
    expect(activeServerKindToFirstRunRuntimeTarget("remote")).toBe("remote");
    expect(activeServerKindToFirstRunRuntimeTarget("cloud")).toBe("elizacloud");
  });
});
