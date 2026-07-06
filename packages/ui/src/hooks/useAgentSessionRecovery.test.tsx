/**
 * @vitest-environment jsdom
 *
 * Tests for useAgentSessionRecovery (#15132): the dead-end -> recovering state
 * transition at the top-level auth gate.
 *
 * This is the regression guard for the reported bug: after a container upgrade,
 * an unauthenticated (`remote_auth_required`) state on a cloud-managed dedicated
 * agent with a valid cloud session must transition to "recovering" (transparent
 * re-pair) instead of "idle" (password-wall dead-end).
 */
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the three environment reads the hook makes so we can drive the decision.
const mockCloudToken = vi.fn<() => string | null>();
const mockActiveServer = vi.fn();
const mockBootConfig = vi.fn(() => ({ cloudApiBase: "https://elizacloud.ai" }));
const mockRunRecovery = vi.fn();

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: () => mockCloudToken(),
}));
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => mockActiveServer(),
}));
vi.mock("../config/boot-config", () => ({
  getBootConfig: () => mockBootConfig(),
}));
vi.mock("../state/agent-session-recovery-runner", () => ({
  runAgentSessionRecovery: (...args: unknown[]) => mockRunRecovery(...args),
}));

import { useAgentSessionRecovery } from "./useAgentSessionRecovery";

function Probe(props: {
  active: boolean;
  reason?: "remote_auth_required" | "remote_password_not_configured";
  onStatus: (s: string) => void;
}) {
  const status = useAgentSessionRecovery({
    active: props.active,
    reason: props.reason,
    navigate: () => {},
  });
  props.onStatus(status);
  return null;
}

function cloudServer(agentId: string) {
  return {
    kind: "cloud" as const,
    id: `cloud:${agentId}`,
    label: "Dedicated",
    apiBase: `https://elizacloud.ai/api/v1/eliza/agents/${agentId}`,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAgentSessionRecovery", () => {
  it("transitions dead-end -> recovering for a cloud agent with a valid cloud session", async () => {
    mockCloudToken.mockReturnValue("steward.jwt.token");
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
    // Never resolves, keeps the hook in "recovering".
    mockRunRecovery.mockReturnValue(new Promise(() => {}));

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_auth_required"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      expect(statuses).toContain("recovering");
    });
    expect(mockRunRecovery).toHaveBeenCalledTimes(1);
    const call = mockRunRecovery.mock.calls[0][0];
    expect(call).toMatchObject({
      agentId: "agent-1",
      cloudApiBase: "https://elizacloud.ai",
      cloudToken: "steward.jwt.token",
    });
  });

  it("stays idle (wall) when there is no cloud session", async () => {
    mockCloudToken.mockReturnValue(null);
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_auth_required"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      expect(statuses.length).toBeGreaterThan(0);
    });
    expect(statuses).not.toContain("recovering");
    expect(mockRunRecovery).not.toHaveBeenCalled();
  });

  it("drops back to idle (wall) when recovery fails", async () => {
    mockCloudToken.mockReturnValue("steward.jwt.token");
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
    mockRunRecovery.mockResolvedValue({
      ok: false,
      reason: "unauthorized",
      message: "no",
    });

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_auth_required"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      // Ended back on idle so the wall renders.
      expect(statuses[statuses.length - 1]).toBe("idle");
    });
  });

  it("does not attempt recovery for the password-not-configured wall", async () => {
    mockCloudToken.mockReturnValue("steward.jwt.token");
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_password_not_configured"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      expect(statuses.length).toBeGreaterThan(0);
    });
    expect(statuses).not.toContain("recovering");
    expect(mockRunRecovery).not.toHaveBeenCalled();
  });
});
