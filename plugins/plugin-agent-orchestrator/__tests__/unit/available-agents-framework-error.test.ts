/**
 * Resilience of availableAgentsProvider when its supplementary framework-state
 * read fails (#12273). The provider augments the ACP adapter list with
 * shell-wired frameworks (opencode) queried via `getTaskAgentFrameworkState`.
 * That read is best-effort — a failure must degrade to "opencode not augmented"
 * rather than break the whole provider — but the failure must be reported via
 * `runtime.reportError` so a broken framework probe is observable instead of
 * silently narrowing the agent's view of its own tools (previously a bare
 * `.catch(() => null)`). Collaborator (`getTaskAgentFrameworkState`) is mocked to
 * throw; the provider itself is exercised for real.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock(
  "../../src/services/task-agent-frameworks.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/services/task-agent-frameworks.js")
      >();
    return {
      ...actual,
      getTaskAgentFrameworkState: vi.fn(() =>
        Promise.reject(new Error("framework probe exploded")),
      ),
    };
  },
);

import { availableAgentsProvider } from "../../src/providers/available-agents.js";
import {
  memory,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

function runtimeWithReport(service: unknown) {
  const reportError = vi.fn();
  const runtime = {
    getService: vi.fn(() => service ?? null),
    hasService: vi.fn(() => Boolean(service)),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reportError,
  } as never;
  return { runtime, reportError };
}

describe("availableAgentsProvider — framework-state read failure", () => {
  it("reports the failure and still returns the base adapters", async () => {
    const { runtime, reportError } = runtimeWithReport(serviceMock());

    const result = await availableAgentsProvider.get(runtime, memory(), state);

    // Degrade, not crash: the base ACP adapters still render.
    expect(result.data?.serviceAvailable).toBe(true);
    expect(result.data?.agents).toEqual([
      {
        adapter: "codex",
        agentType: "codex",
        installed: true,
        auth: { status: "unknown" },
      },
    ]);

    // The swallowed probe failure is now observable.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "AgentOrchestrator.AVAILABLE_AGENTS",
      expect.any(Error),
      {
        provider: "AVAILABLE_AGENTS",
        operation: "getTaskAgentFrameworkState",
        reason: "provider_backend_unavailable",
      },
    );
  });
});
