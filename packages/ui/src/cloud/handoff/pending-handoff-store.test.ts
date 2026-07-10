// @vitest-environment jsdom

/**
 * Marker-store contract for the pending cloud-handoff record (#15902): the
 * save/load/clear roundtrip, TTL expiry clearing on read, and malformed-entry
 * self-cleaning — real jsdom localStorage, nothing mocked.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingCloudHandoff,
  loadPendingCloudHandoff,
  PENDING_HANDOFF_TTL_MS,
  type PendingCloudHandoff,
  savePendingCloudHandoff,
} from "./pending-handoff-store";

const STORAGE_KEY = "eliza:cloud-handoff-pending";

function marker(
  overrides: Partial<PendingCloudHandoff> = {},
): PendingCloudHandoff {
  return {
    sharedAgentId: "shared-1",
    dedicatedAgentId: "dedicated-1",
    sharedApiBase: "https://elizacloud.ai/api/v1/eliza/agents/shared-1",
    cloudApiBase: "https://elizacloud.ai",
    startedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("pending-handoff-store", () => {
  it("roundtrips save → load → clear", () => {
    const pending = marker();
    savePendingCloudHandoff(pending);
    expect(loadPendingCloudHandoff()).toEqual(pending);
    clearPendingCloudHandoff();
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("expires a marker past the TTL and CLEARS it from storage on read", () => {
    const startedAt = 1_000_000;
    savePendingCloudHandoff(marker({ startedAt }));
    const justPastTtl = startedAt + PENDING_HANDOFF_TTL_MS + 1;
    expect(loadPendingCloudHandoff(justPastTtl)).toBeNull();
    // The expired marker must not survive to pin a later boot's widget.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps a marker still inside the TTL", () => {
    const startedAt = 1_000_000;
    savePendingCloudHandoff(marker({ startedAt }));
    const withinTtl = startedAt + PENDING_HANDOFF_TTL_MS - 1;
    expect(loadPendingCloudHandoff(withinTtl)?.sharedAgentId).toBe("shared-1");
  });

  it("clears a malformed entry instead of returning a fake-valid record", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("clears an entry with missing required fields", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sharedAgentId: "shared-1", startedAt: Date.now() }),
    );
    expect(loadPendingCloudHandoff()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
