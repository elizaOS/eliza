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

// Mock the environment reads the hook makes so we can drive the decision.
const mockCloudToken = vi.fn<() => string | null>();
const mockActiveServer = vi.fn();
const mockBootConfig = vi.fn(() => ({ cloudApiBase: "https://elizacloud.ai" }));
const mockRunRecovery = vi.fn();
// Silent cookie->session recovery for the returning-PWA dead-end. Default:
// no cookie (returns null) so pre-existing cases keep their old behavior.
const mockEnsureCloudSession = vi.fn<() => Promise<string | null>>(async () =>
  Promise.resolve(null),
);

vi.mock("../api/client-cloud", () => ({
  getCloudAuthToken: () => mockCloudToken(),
  // The recovery resolver/predicate treats a direct cloud shared-agent base as
  // cloud-managed. Our test servers use kind:"cloud"/"local", so this is only
  // consulted for the non-cloud (local) case, where it must return false.
  isDirectCloudSharedAgentBase: () => false,
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
vi.mock("../state/cloud-session-refresh-for-repair", () => ({
  ensureCloudSessionForRepair: () => mockEnsureCloudSession(),
}));
const mockClearStalePairCredentialsForAgent = vi.fn();
vi.mock("../state/cloud-pair-token", () => ({
  clearStalePairCredentialsForAgent: (agentId: string) =>
    mockClearStalePairCredentialsForAgent(agentId),
}));

import { useAgentSessionRecovery } from "./useAgentSessionRecovery";

// Stable navigate identity across re-renders (mirrors the real app's
// module-level `defaultNavigate`). An unstable navigate would churn the effect
// deps and cancel an in-flight async re-pair — which the real app never does.
const STABLE_NAVIGATE = () => {};

function Probe(props: {
  active: boolean;
  reason?: "remote_auth_required" | "remote_password_not_configured";
  onStatus: (s: string) => void;
}) {
  const status = useAgentSessionRecovery({
    active: props.active,
    reason: props.reason,
    navigate: STABLE_NAVIGATE,
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
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.clearAllMocks();
  // Restore the default "no cookie" behavior after clearAllMocks wipes it.
  mockEnsureCloudSession.mockImplementation(async () => Promise.resolve(null));
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

  it("opts into an agent-scoped purge after the adopted bearer was rejected", async () => {
    mockCloudToken.mockReturnValue("steward.jwt.token");
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
    mockRunRecovery.mockReturnValue(new Promise(() => {}));

    render(<Probe active reason="remote_auth_required" onStatus={() => {}} />);

    await waitFor(() => expect(mockRunRecovery).toHaveBeenCalledTimes(1));
    const deps = mockRunRecovery.mock.calls[0][0] as {
      clearStalePairCredentials?: () => void;
    };
    expect(deps.clearStalePairCredentials).toEqual(expect.any(Function));
    deps.clearStalePairCredentials?.();
    expect(mockClearStalePairCredentialsForAgent).toHaveBeenCalledWith(
      "agent-1",
    );
  });

  it("uses in-process pairing on native so the WebView stays on the app origin", async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
    };
    mockCloudToken.mockReturnValue("steward.jwt.token");
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
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
    expect(mockRunRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        consumeRedirectInProcess: true,
        onPairedInProcess: expect.any(Function),
      }),
    );
  });

  it("stays idle (wall) when there is no cloud session AND no recoverable cookie", async () => {
    mockCloudToken.mockReturnValue(null);
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
    // No shared cookie -> ensureCloudSessionForRepair resolves null (default).

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_auth_required"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      // Ends on idle so the notice/wall renders honestly.
      expect(statuses[statuses.length - 1]).toBe("idle");
    });
    expect(mockRunRecovery).not.toHaveBeenCalled();
  });

  it("REGRESSION: returning PWA with no app-origin token but a live Eliza Cloud cookie silently re-pairs instead of dead-ending", async () => {
    // The exact reported dead-end: `getCloudAuthToken()` is null on the agent
    // subdomain (cold PWA relaunch, empty localStorage mirror), but the shared
    // HttpOnly `.elizacloud.ai` session cookie is live. The hook must recover
    // the session from the cookie and re-pair, NOT drop to
    // `CloudHostedAgentAuthNotice`.
    let token: string | null = null;
    mockCloudToken.mockImplementation(() => token);
    mockActiveServer.mockReturnValue(cloudServer("agent-1"));
    mockEnsureCloudSession.mockImplementation(async () => {
      // Simulate the cookie refresh landing a fresh app-origin token.
      token = "steward.jwt.recovered";
      return token;
    });
    mockRunRecovery.mockReturnValue(new Promise(() => {})); // stays recovering

    const statuses: string[] = [];
    render(
      <Probe
        active
        reason="remote_auth_required"
        onStatus={(s) => statuses.push(s)}
      />,
    );

    await waitFor(() => {
      expect(mockRunRecovery).toHaveBeenCalledTimes(1);
    });
    expect(statuses).toContain("recovering");
    expect(mockEnsureCloudSession).toHaveBeenCalledTimes(1);
    expect(mockRunRecovery.mock.calls[0][0]).toMatchObject({
      agentId: "agent-1",
      cloudApiBase: "https://elizacloud.ai",
      cloudToken: "steward.jwt.recovered",
    });
  });

  it("does not attempt a cookie refresh for a self-hosted (non-cloud) server", async () => {
    mockCloudToken.mockReturnValue(null);
    mockActiveServer.mockReturnValue({
      kind: "local" as const,
      id: "local:1",
      label: "Local",
      apiBase: "http://localhost:7777",
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
      expect(statuses[statuses.length - 1]).toBe("idle");
    });
    // A self-hosted wall is honest: never touch the cloud cookie refresh.
    expect(mockEnsureCloudSession).not.toHaveBeenCalled();
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
