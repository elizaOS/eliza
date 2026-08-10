/** Validates Cloud pairing DTO guards, scoped storage, and handoff escaping. */

import { describe, expect, it } from "vitest";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  cloudPairTokenKeyForAgent,
  isCloudPairAgentId,
  parseCloudPairRelaySession,
  renderCloudPairHandoffHtml,
  resolveCloudPairAgentIdFromEnv,
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

  it("resolves the canonical and compatibility platform identities", () => {
    expect(
      resolveCloudPairAgentIdFromEnv({
        ELIZA_CLOUD_AGENT_ID: AGENT_ID,
        WAIFU_ELIZA_CLOUD_AGENT_ID: "66666666-6666-4666-8666-666666666666",
      }),
    ).toBe(AGENT_ID);
    expect(
      resolveCloudPairAgentIdFromEnv({
        WAIFU_ELIZA_CLOUD_AGENT_ID: AGENT_ID,
      }),
    ).toBe(AGENT_ID);
  });

  it("rejects missing and malformed platform identities", () => {
    expect(resolveCloudPairAgentIdFromEnv({})).toBeNull();
    expect(
      resolveCloudPairAgentIdFromEnv({ ELIZA_CLOUD_AGENT_ID: "agent-1" }),
    ).toBeNull();
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

  it("renders one inert script boundary for opaque bearer content", () => {
    const apiKey = `agent_a"</script><script>alert(1)</script>`;
    const html = renderCloudPairHandoffHtml(apiKey, AGENT_ID);

    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html.replace(/<\/script>/, "")).not.toContain("</script>");
    expect(html).toContain(`eliza:cloud-pair:api-token:${AGENT_ID}`);
    expect(html).toContain("\\u003c/script>");
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
