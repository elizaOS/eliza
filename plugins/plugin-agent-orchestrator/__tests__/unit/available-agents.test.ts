/**
 * Verifies availableAgentsProvider.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { mock } from "bun:test";
import { describe, expect, it, vi } from "vitest";

// Control the framework-state probe so we can drive its failure path
// deterministically without touching the filesystem / env discovery it does.
const getTaskAgentFrameworkStateMock = vi.fn();
mock.module("../../src/services/task-agent-frameworks.js", () => {
  return {
    getTaskAgentFrameworkState: (...args: unknown[]) =>
      getTaskAgentFrameworkStateMock(...args),
  };
});

import {
  memory,
  runtimeWith,
  serviceMock,
  session,
  state,
} from "../../src/test-utils/action-test-utils.js";

const { availableAgentsProvider } = await import(
  "../../src/providers/available-agents.js"
);

// Default: an empty, healthy framework state (probe succeeded, nothing extra
// installed) so the pre-existing behavioural assertions below are unaffected.
getTaskAgentFrameworkStateMock.mockResolvedValue({ frameworks: [] });

describe("availableAgentsProvider", () => {
  it("returns service unavailable data", async () => {
    const result = await availableAgentsProvider.get(
      runtimeWith(undefined),
      memory(),
      state,
    );
    expect(result.data?.serviceAvailable).toBe(false);
    expect(result.data?.agents).toEqual([]);
  });
  it("returns available adapters and active sessions", async () => {
    const result = await availableAgentsProvider.get(
      runtimeWith(serviceMock()),
      memory(),
      state,
    );
    expect(result.data?.serviceAvailable).toBe(true);
    expect(result.data?.agents).toEqual([
      {
        adapter: "codex",
        agentType: "codex",
        installed: true,
        auth: { status: "unknown" },
      },
    ]);
    expect(result.data?.activeSessions).toEqual([
      {
        id: "abcdef123456",
        label: "demo",
        agentType: "codex",
        status: "ready",
        workdir: "/tmp/acp",
      },
    ]);
  });

  it("surfaces a thrown framework probe as a visible degrade instead of silent absence", async () => {
    // A framework probe THROW = broken backend, not "opencode absent".
    // Swallowing it into a healthy-looking null (old `.catch(() => null)`)
    // let the planner read the same slate as genuine absence and silently
    // drop opencode with no signal (#12273 healthy-empty-from-catch).
    const probeError = new Error("framework discovery filesystem walk failed");
    getTaskAgentFrameworkStateMock.mockRejectedValueOnce(probeError);
    const reportError = vi.fn();
    const runtime = runtimeWith(serviceMock());
    (runtime as unknown as { reportError: unknown }).reportError = reportError;

    const result = await availableAgentsProvider.get(runtime, memory(), state);

    // Failure is observable to the RECENT_ERRORS provider / developer, not
    // swallowed.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe(
      "AgentOrchestrator.AVAILABLE_AGENTS",
    );
    expect(reportError.mock.calls[0]?.[1]).toBe(probeError);
    // The context is flagged degraded so a probe crash is distinct from a
    // healthy "nothing extra installed" state.
    expect(result.data?.frameworkProbeFailed).toBe(true);
    // The planner sees the degrade in-band, not a clean slate.
    expect(result.text).toContain("framework probe unavailable");
    // Still returns a usable result (no crash); adapter inventory + sessions
    // from the service side are unaffected.
    expect(result.data?.serviceAvailable).toBe(true);
  });

  it("does not flag degraded when the framework probe succeeds", async () => {
    getTaskAgentFrameworkStateMock.mockResolvedValueOnce({ frameworks: [] });
    const result = await availableAgentsProvider.get(
      runtimeWith(serviceMock()),
      memory(),
      state,
    );
    expect(result.data?.frameworkProbeFailed).toBe(false);
    expect(result.text).not.toContain("framework probe unavailable");
  });

  it("caps rendered sessions while keeping all structured session data", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) =>
      session({
        id: `session-${String(index).padStart(2, "0")}`,
        status: index < 3 ? "ready" : "completed",
        lastActivityAt: new Date(
          Date.parse("2026-05-03T10:00:00.000Z") + index * 1000,
        ),
        metadata: { label: `demo-${index}` },
      }),
    );
    const result = await availableAgentsProvider.get(
      runtimeWith(serviceMock({ listSessions: () => sessions })),
      memory(),
      state,
    );

    expect(result.data?.activeSessions).toHaveLength(12);
    expect(result.text).toContain("Active sessions (12)");
    expect(result.text).toContain("... (+4 older sessions omitted)");
    expect(result.text?.match(/- demo-/g)).toHaveLength(8);
    expect(result.text).toContain("demo-2");
    expect(result.text).toContain("demo-0");
    expect(result.text).not.toContain("demo-3");
  });
});
