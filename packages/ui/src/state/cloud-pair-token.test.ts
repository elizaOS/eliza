// @vitest-environment jsdom

/**
 * Delete channel for the durable cloud-pair API token (#16666): the clear must
 * empty BOTH storages the write channel targets, or the boot adopter
 * (localStorage first, sessionStorage fallback) re-adopts the dead credential
 * on the next launch. jsdom + real storages; no network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearCloudPairApiToken } from "./cloud-pair-token";

const KEY = "eliza:cloud-pair:api-token";

describe("clearCloudPairApiToken", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("removes the durable pair token from BOTH storages", () => {
    localStorage.setItem(KEY, "stale-key");
    sessionStorage.setItem(KEY, "stale-key");
    localStorage.setItem("eliza:unrelated", "keep-me");

    clearCloudPairApiToken();

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(localStorage.getItem("eliza:unrelated")).toBe("keep-me");
  });

  it("is a safe no-op when the key is absent", () => {
    expect(() => clearCloudPairApiToken()).not.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("targets the exact key the write channel uses", async () => {
    // Guards against a silent rename drift between the write channel
    // (CloudPairRelay) and this delete channel: both must share the literal.
    const relay = await import("../components/auth/CloudPairRelay");
    expect(relay.CLOUD_PAIR_SESSION_STORAGE_KEY).toBe(KEY);
    expect(relay.CLOUD_PAIR_LOCAL_STORAGE_KEY).toBe(KEY);
  });
});
