/**
 * Deterministic tests for companion session claiming and service-worker
 * restart recovery.
 */
import type { BrowserBridgeCompanionStatus } from "@elizaos/plugin-browser";
import { describe, expect, it } from "vitest";
import type { LifeOpsBrowserSession } from "../src/contracts/index.js";
import { selectBrowserSessionForCompanion } from "../src/lifeops/domains/browser-session-claim.js";

const companion: BrowserBridgeCompanionStatus = {
  id: "companion-a",
  agentId: "agent-a",
  browser: "chrome",
  profileId: "profile-a",
  profileLabel: "Default",
  label: "Chrome",
  extensionVersion: "1.0.0",
  connectionState: "connected",
  permissions: {
    tabs: true,
    scripting: true,
    activeTab: true,
    allOrigins: false,
    grantedOrigins: ["https://allowed.example/*"],
    incognitoEnabled: false,
  },
  lastSeenAt: null,
  pairedAt: null,
  metadata: {},
  createdAt: "2026-08-17T10:00:00.000Z",
  updatedAt: "2026-08-17T10:00:00.000Z",
};

function session(
  id: string,
  status: LifeOpsBrowserSession["status"],
  metadata: Record<string, unknown>,
  createdAt: string,
): LifeOpsBrowserSession {
  return {
    id,
    agentId: companion.agentId,
    domain: "browser",
    subjectType: "owner",
    subjectId: "owner-a",
    visibilityScope: "owner",
    contextPolicy: "owner_private",
    workflowId: null,
    browser: companion.browser,
    companionId: companion.id,
    profileId: companion.profileId,
    windowId: "1",
    tabId: "2",
    title: id,
    status,
    actions: [],
    currentActionIndex: 1,
    awaitingConfirmationForActionId: null,
    result: {},
    metadata,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
  };
}

describe("selectBrowserSessionForCompanion", () => {
  it("resumes a session claimed before worker eviction", () => {
    const queued = session(
      "queued-next",
      "queued",
      {},
      "2026-08-17T10:00:00.000Z",
    );
    const interrupted = session(
      "running-interrupted",
      "running",
      { claimedByCompanionId: companion.id },
      "2026-08-17T10:01:00.000Z",
    );
    expect(
      selectBrowserSessionForCompanion([queued, interrupted], companion)?.id,
    ).toBe(interrupted.id);
  });

  it("never resumes a session claimed by another companion", () => {
    const foreign = session(
      "running-foreign",
      "running",
      { claimedByCompanionId: "companion-b" },
      "2026-08-17T09:00:00.000Z",
    );
    const queued = session(
      "queued-local",
      "queued",
      {},
      "2026-08-17T10:00:00.000Z",
    );
    expect(
      selectBrowserSessionForCompanion([foreign, queued], companion)?.id,
    ).toBe(queued.id);
  });
});
