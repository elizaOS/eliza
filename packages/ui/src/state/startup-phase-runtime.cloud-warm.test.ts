import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStartingRuntime } from "./startup-phase-runtime";

/**
 * Cold-boot routing regression for Eliza-MANAGED cloud agents.
 *
 * The bug: the startup coordinator declared a cloud agent "ready" off the
 * orchestrator/status shim (which reports running the instant the agent is
 * provisioned), but the per-agent PROXY passthrough
 * (`/api/v1/eliza/agents/<id>/api/*`) 404s "Agent not found" for the first
 * ~minutes while the container binds the runtime. Flipping ready off the shim
 * routed the user to a washed-out /character/select during warm-up.
 *
 * The fix (this suite locks it): for a managed cloud agent, gate readiness on
 * the passthrough genuinely serving (`GET /api/conversations` via
 * listConversations). While it 404s we stay in starting-runtime (booting chat)
 * and the deadline keeps sliding; once it serves we dispatch AGENT_RUNNING once.
 *
 * The shared-code constraint: the desktop/mobile embedded-local first-run and
 * the self-hosted remote-backend paths must be UNCHANGED — the last two cases
 * are the non-negotiable regression guards.
 */

const clientMock = vi.hoisted(() => ({
  getLaunchProgress: vi.fn(),
  getBootProgress: vi.fn(),
  getStatus: vi.fn(),
  getAuthStatus: vi.fn(),
  hasToken: vi.fn(),
  startAgent: vi.fn(),
  listConversations: vi.fn(),
}));

const persistenceMock = vi.hoisted(() => ({
  loadPersistedActiveServer: vi.fn(),
}));

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("./persistence", () => ({
  loadPersistedActiveServer: persistenceMock.loadPersistedActiveServer,
}));

function createDeps() {
  return {
    setAgentStatus: vi.fn(),
    setConnected: vi.fn(),
    setStartupError: vi.fn(),
    setFirstRunLoading: vi.fn(),
    setAuthRequired: vi.fn(),
    setPairingEnabled: vi.fn(),
    setPairingExpiresAt: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
  };
}

const RUNNING_STATUS = {
  state: "running" as const,
  agentName: "Cloud Agent",
  model: "cloud-model",
  uptime: 1_000,
  startedAt: Date.now() - 1_000,
};

describe("runStartingRuntime — managed cloud cold-boot warmup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.getLaunchProgress.mockResolvedValue(null);
    clientMock.getBootProgress.mockResolvedValue(null);
    clientMock.getStatus.mockResolvedValue(RUNNING_STATUS);
    clientMock.hasToken.mockReturnValue(true);
    // Default: no persisted server (behaves as non-cloud for the shared paths).
    persistenceMock.loadPersistedActiveServer.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays in starting-runtime while the proxy passthrough 404s, never flips ready, and keeps extending the deadline (no premature timeout)", async () => {
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
    });

    // Drive time forward well past the initial 180s budget on each poll so a
    // NON-sliding deadline would already have tripped AGENT_TIMEOUT. The slide
    // (effective "starting" state) must keep the deadline ahead instead.
    let nowValue = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue);

    const cancelled = { current: false };
    // Warming: the passthrough keeps 404ing. Bound the loop by cancelling after
    // a handful of probes (each probe jumps the clock by a full minute).
    let probes = 0;
    clientMock.listConversations.mockImplementation(async () => {
      probes += 1;
      nowValue += 60_000; // +60s per probe → 5 probes ≈ 5 minutes elapsed
      if (probes >= 5) cancelled.current = true;
      throw { status: 404, message: "Agent not found" };
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      cancelled,
      { current: null },
      "cloud-managed",
    );

    // Probed the genuine passthrough, never the local boot/status path.
    expect(clientMock.listConversations).toHaveBeenCalled();
    expect(clientMock.startAgent).not.toHaveBeenCalled();
    expect(clientMock.getBootProgress).not.toHaveBeenCalled();
    expect(clientMock.getLaunchProgress).not.toHaveBeenCalled();

    // Never declared ready, never surfaced a timeout — we simply kept waiting.
    expect(dispatch).not.toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "AGENT_TIMEOUT" });
    expect(deps.setStartupError).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it("dispatches AGENT_RUNNING exactly once when the proxy passthrough is genuinely serving", async () => {
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
    });

    clientMock.listConversations.mockResolvedValue({ conversations: [] });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "cloud-managed",
    );

    expect(clientMock.listConversations).toHaveBeenCalledTimes(1);
    // Hydration fills the full status once the passthrough serves.
    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(deps.setFirstRunLoading).toHaveBeenCalledWith(false);
    expect(deps.setStartupError).not.toHaveBeenCalled();

    const runningDispatches = dispatch.mock.calls.filter(
      ([e]) => e.type === "AGENT_RUNNING",
    );
    expect(runningDispatches).toHaveLength(1);
  });

  it("warms first, then advances: 404 → 404 → serving dispatches AGENT_RUNNING once", async () => {
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Eliza Cloud",
    });

    let call = 0;
    clientMock.listConversations.mockImplementation(async () => {
      call += 1;
      if (call < 3) throw { status: 404, message: "Agent not found" };
      return { conversations: [] };
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "cloud-managed",
    );

    expect(clientMock.listConversations).toHaveBeenCalledTimes(3);
    const runningDispatches = dispatch.mock.calls.filter(
      ([e]) => e.type === "AGENT_RUNNING",
    );
    expect(runningDispatches).toHaveLength(1);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "AGENT_TIMEOUT" });
  });

  // ── REGRESSION GUARDS (shared-code constraint) ─────────────────────────

  it("REGRESSION: a self-hosted remote-backend still advances immediately without probing the cloud passthrough", async () => {
    // remote-backend never persists kind:"cloud" — even if a stale cloud record
    // existed, the target guard keeps remote on its immediate-ready path.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      id: "remote:https://my.server",
      kind: "remote",
      label: "my.server",
      apiBase: "https://my.server",
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "remote-backend",
    );

    // No cloud warmup: the passthrough probe is never issued.
    expect(clientMock.listConversations).not.toHaveBeenCalled();
    expect(clientMock.startAgent).not.toHaveBeenCalled();
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("REGRESSION: desktop/embedded-local first-run advances via boot progress on state:running, untouched by the cloud gate", async () => {
    // Embedded-local (desktop first-run) has NO persisted cloud kind and takes
    // the full boot/poll loop. A running boot snapshot advances exactly as today
    // — proving the non-cloud path and the boot ready branch are unchanged.
    persistenceMock.loadPersistedActiveServer.mockReturnValue({
      id: "local:embedded",
      kind: "local",
      label: "This device",
    });
    clientMock.getBootProgress.mockResolvedValue({
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 22,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Eliza",
      port: 31337,
      startedAt: Date.now() - 1_000,
      updatedAt: new Date().toISOString(),
    });

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "embedded-local",
    );

    // The cloud passthrough probe is never issued on the local path.
    expect(clientMock.listConversations).not.toHaveBeenCalled();
    expect(clientMock.getBootProgress).toHaveBeenCalled();
    expect(clientMock.getStatus).toHaveBeenCalled();
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
    expect(deps.setStartupError).not.toHaveBeenCalled();
  });

  it("REGRESSION: a cloud-managed target WITHOUT a persisted cloud record keeps the immediate-ready fast path (no passthrough probe)", async () => {
    // Defensive: if the target says cloud-managed but nothing cloud is persisted
    // (e.g. an odd restore), fall back to today's behavior rather than blocking
    // on a passthrough that may not apply.
    persistenceMock.loadPersistedActiveServer.mockReturnValue(null);

    const dispatch = vi.fn();
    const deps = createDeps();

    await runStartingRuntime(
      deps,
      dispatch,
      1,
      { current: 1 },
      { current: false },
      { current: null },
      "cloud-managed",
    );

    expect(clientMock.listConversations).not.toHaveBeenCalled();
    expect(deps.setConnected).toHaveBeenCalledWith(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "AGENT_RUNNING" });
  });
});
