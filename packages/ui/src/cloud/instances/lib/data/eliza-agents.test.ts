/** Validates the signed-in agents-list transport at its untrusted JSON boundary. */

import { describe, expect, it } from "vitest";
import { parseAgentsResponse } from "./eliza-agents";

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    agentName: "Ada",
    status: "running",
    databaseStatus: "ready",
    lastBackupAt: null,
    lastHeartbeatAt: "2026-08-16T01:02:03.000Z",
    errorMessage: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-16T01:02:03.000Z",
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    dockerImage: null,
    executionTier: "shared",
    webUiUrl: null,
    activeJob: null,
    ...overrides,
  };
}

describe("parseAgentsResponse", () => {
  it("returns the backend-owned list shape without additive transport fields", () => {
    const [parsed] = parseAgentsResponse({
      success: true,
      data: [agent({ ignoredInfrastructureField: "do-not-copy" })],
    });

    expect(parsed).toEqual(agent());
    expect(parsed).not.toHaveProperty("ignoredInfrastructureField");
    expect(parsed).not.toHaveProperty("node_id");
    expect(parsed).not.toHaveProperty("sandbox_id");
  });

  it.each([
    {},
    { success: false, data: [] },
    { success: true },
    { success: true, data: {} },
  ])("rejects a malformed success envelope", (payload) => {
    expect(() => parseAgentsResponse(payload)).toThrow(
      "Agents response did not include a successful data list",
    );
  });

  it.each([
    agent({ id: "" }),
    agent({ status: "healthy" }),
    agent({ databaseStatus: "connected" }),
    agent({ executionTier: "free" }),
    agent({ createdAt: "yesterday" }),
    agent({ lastHeartbeatAt: 123 }),
    agent({ token_ticker: undefined }),
  ])("rejects an invalid agent record", (record) => {
    expect(() =>
      parseAgentsResponse({ success: true, data: [record] }),
    ).toThrow("Agents response contained an invalid agent record");
  });

  it("rejects a malformed active lifecycle job", () => {
    expect(() =>
      parseAgentsResponse({
        success: true,
        data: [agent({ activeJob: { id: "job-1" } })],
      }),
    ).toThrow("Agents response contained an invalid active job");
  });

  it("accepts the server-owned active lifecycle job needed to resume polling", () => {
    const activeJob = {
      id: "job-1",
      type: "agent_provision",
      status: "in_progress",
      attempts: 1,
      maxAttempts: 3,
      estimatedCompletionAt: "2026-08-16T01:05:00.000Z",
      scheduledFor: "2026-08-16T01:02:00.000Z",
      startedAt: "2026-08-16T01:02:03.000Z",
      createdAt: "2026-08-16T01:01:59.000Z",
      updatedAt: "2026-08-16T01:02:03.000Z",
    };
    const [parsed] = parseAgentsResponse({
      success: true,
      data: [agent({ activeJob })],
    });

    expect(parsed.activeJob).toEqual(activeJob);
  });

  it("fails the whole list when any record is invalid", () => {
    expect(() =>
      parseAgentsResponse({
        success: true,
        data: [agent(), agent({ id: "agent-2", updatedAt: null })],
      }),
    ).toThrow("Agents response contained an invalid agent record");
  });
});
