/** Validates the Cloud pairing DTO guards and stable scoped-storage key contract. */

import { describe, expect, it } from "vitest";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  cloudPairTokenKeyForAgent,
  isCloudPairAgentId,
  parseCloudPairRelaySession,
} from "./cloud-pair.js";

const AGENT_ID = "55555555-5555-4555-8555-555555555555";

describe("Cloud pairing contract", () => {
  it("builds the stable per-agent storage key", () => {
    expect(cloudPairTokenKeyForAgent(AGENT_ID)).toBe(
      `${CLOUD_PAIR_LEGACY_STORAGE_KEY}:${AGENT_ID}`,
    );
  });

  it("validates dedicated-agent UUIDs", () => {
    expect(isCloudPairAgentId(AGENT_ID)).toBe(true);
    expect(isCloudPairAgentId("not-an-agent")).toBe(false);
    expect(isCloudPairAgentId(123)).toBe(false);
  });

  it("parses a valid relay session without trusting unrelated fields", () => {
    expect(
      parseCloudPairRelaySession({
        apiKey: "agent_secret_value",
        agentId: AGENT_ID,
        agentName: "Nova",
        ignored: true,
      }),
    ).toEqual({
      apiKey: "agent_secret_value",
      agentId: AGENT_ID,
      agentName: "Nova",
    });
  });

  it("preserves an opaque bearer byte-for-byte", () => {
    const apiKey = "  agent_secret_value  ";
    expect(
      parseCloudPairRelaySession({
        apiKey,
        agentId: AGENT_ID,
      }),
    ).toEqual({ apiKey, agentId: AGENT_ID });
  });

  it("rejects missing or malformed bearer ownership", () => {
    expect(
      parseCloudPairRelaySession({ apiKey: "agent_secret_value" }),
    ).toBeNull();
    expect(
      parseCloudPairRelaySession({
        apiKey: "agent_secret_value",
        agentId: "not-an-agent",
      }),
    ).toBeNull();
    expect(
      parseCloudPairRelaySession({ apiKey: "", agentId: AGENT_ID }),
    ).toBeNull();
    expect(
      parseCloudPairRelaySession({ apiKey: "   ", agentId: AGENT_ID }),
    ).toBeNull();
  });
});
