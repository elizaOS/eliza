/**
 * Tests for the post-upgrade agent-session recovery decision (#15132).
 *
 * After a dedicated cloud agent's container is upgraded (blue/green recreate),
 * the browser's persisted agent credential belongs to the OLD container, so
 * every agent-subdomain call 401s and the app renders the agent's internal
 * password wall, a credential no cloud user possesses. This is a terminal
 * dead-end.
 *
 * `resolveAgentSessionRecovery` decides whether the client can transparently
 * re-pair via the still-valid cloud session (the same flow first-pairing uses)
 * instead of stranding the user at the password wall. The wall must remain the
 * behavior ONLY when there is no cloud session (self-hosted direct access).
 */
import { describe, expect, it } from "vitest";
import {
  type AgentSessionRecoveryDecision,
  resolveAgentSessionRecovery,
} from "./agent-session-recovery";

function cloudServer(agentId: string) {
  return {
    kind: "cloud" as const,
    id: `cloud:${agentId}`,
    label: "Dedicated",
    apiBase: `https://elizacloud.ai/api/v1/eliza/agents/${agentId}`,
  };
}

describe("resolveAgentSessionRecovery", () => {
  it("re-pairs when a cloud-managed dedicated agent 401s with a valid cloud session", () => {
    const decision: AgentSessionRecoveryDecision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: cloudServer("23766030-0000-0000-0000-000000000000"),
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("re-pair");
    if (decision.action === "re-pair") {
      expect(decision.agentId).toBe("23766030-0000-0000-0000-000000000000");
      expect(decision.cloudApiBase).toBe("https://elizacloud.ai");
    }
  });

  it("falls back to the password wall when there is NO cloud session (self-hosted)", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: {
        kind: "remote",
        id: "remote:vps",
        label: "VPS",
        apiBase: "https://box.example.com",
      },
      cloudToken: null,
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("show-wall");
  });

  it("does NOT re-pair a cloud agent when the cloud session is also gone", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: cloudServer("agent-1"),
      cloudToken: null,
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    // No cloud session ⇒ nothing to re-pair with ⇒ wall is the honest state.
    expect(decision.action).toBe("show-wall");
  });

  it("does not loop: after an attempt already ran, show the wall", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: cloudServer("agent-1"),
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: true,
    });

    expect(decision.action).toBe("show-wall");
  });

  it("does not re-pair the password-not-configured wall (no agent credential to refresh)", () => {
    // remote_password_not_configured means the host never set an owner password;
    // re-pairing cannot manufacture one. Keep the actionable setup wall.
    const decision = resolveAgentSessionRecovery({
      reason: "remote_password_not_configured",
      activeServer: cloudServer("agent-1"),
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("show-wall");
  });

  it("does not re-pair a local runtime (same-origin, not a cloud dedicated agent)", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: {
        kind: "local",
        id: "local",
        label: "Local",
      },
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("show-wall");
  });

  it("does not re-pair when the active server is missing (nothing to recover)", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: null,
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("show-wall");
  });

  it("resolves the agent id from a cloud apiBase when the id prefix is absent", () => {
    const decision = resolveAgentSessionRecovery({
      reason: "remote_auth_required",
      activeServer: {
        kind: "cloud",
        // Older persisted records may not use the `cloud:<id>` id form; the
        // agent id must still be recoverable from the REST adapter base.
        id: "cloud",
        label: "Dedicated",
        apiBase: "https://elizacloud.ai/api/v1/eliza/agents/abc-123",
      },
      cloudToken: "steward.jwt.token",
      cloudApiBase: "https://elizacloud.ai",
      alreadyAttempted: false,
    });

    expect(decision.action).toBe("re-pair");
    if (decision.action === "re-pair") {
      expect(decision.agentId).toBe("abc-123");
    }
  });
});
