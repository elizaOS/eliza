/**
 * Unit coverage for the cloud-login-pending flag that resumes onboarding after a
 * redirect. localStorage-backed, no live cloud.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __TEST_ONLY__,
  clearCloudLoginPending,
  markCloudLoginPending,
  readCloudLoginPending,
} from "./first-run-cloud-resume";

function stubLocalStorage(): void {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
        removeItem: (k: string) => void items.delete(k),
      },
    },
  });
}

describe("first-run cloud-resume marker", () => {
  beforeEach(() => stubLocalStorage());
  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });
  });

  it("round-trips a cloud marker and clears it", () => {
    expect(readCloudLoginPending()).toBeNull();
    markCloudLoginPending({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
    expect(readCloudLoginPending()).toEqual({
      runtime: "cloud",
      localInference: "cloud-inference",
      agentName: "Eliza",
    });
    clearCloudLoginPending();
    expect(readCloudLoginPending()).toBeNull();
  });

  it("round-trips a hybrid marker", () => {
    markCloudLoginPending({
      runtime: "hybrid",
      localInference: "cloud-inference",
      agentName: "Nova",
    });
    expect(readCloudLoginPending()?.runtime).toBe("hybrid");
  });

  it("rejects a corrupt / non-cloud marker instead of resuming into a bad state", () => {
    window.localStorage.setItem(
      __TEST_ONLY__.CLOUD_RESUME_STORAGE_KEY,
      JSON.stringify({ runtime: "local", localInference: "all-local" }),
    );
    expect(readCloudLoginPending()).toBeNull();
    window.localStorage.setItem(
      __TEST_ONLY__.CLOUD_RESUME_STORAGE_KEY,
      "{ not json",
    );
    expect(readCloudLoginPending()).toBeNull();
  });
});
