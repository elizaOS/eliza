import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { getAcpService } from "../../src/actions/common.ts";

/**
 * Pins the resolution order in `getAcpService`. The PTY_SERVICE (the
 * orchestrator path that spawns via `coding-agent-adapters`) must be
 * preferred over any ACP-prefixed service. Before this order swap, ACP
 * services were tried first and silently shadowed the working PTY path
 * whenever `acpx` happened to register cleanly — meaning the same
 * planner-visible action surface produced different spawn pipelines
 * depending on ACP state.
 */
describe("getAcpService resolution order", () => {
  function buildRuntime(services: Record<string, unknown>): IAgentRuntime {
    return {
      getService: vi.fn((key: string) => services[key] ?? null),
    } as unknown as IAgentRuntime;
  }

  const PTY = { kind: "PTY" } as const;
  const ACP_SUB = { kind: "ACP_SUBPROCESS" } as const;
  const ACP = { kind: "ACP" } as const;

  it("returns PTY_SERVICE first when it's registered alongside ACP services", () => {
    const runtime = buildRuntime({
      PTY_SERVICE: PTY,
      ACP_SERVICE: ACP,
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(PTY);
  });

  it("falls back to ACP_SERVICE when PTY_SERVICE is absent", () => {
    const runtime = buildRuntime({
      ACP_SERVICE: ACP,
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(ACP);
  });

  it("falls back to ACP_SUBPROCESS_SERVICE when only it is present", () => {
    const runtime = buildRuntime({
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(ACP_SUB);
  });

  it("returns undefined when no relevant service is registered", () => {
    const runtime = buildRuntime({});
    expect(getAcpService(runtime)).toBeUndefined();
  });

  it("PTY wins even when ACP_SUBPROCESS_SERVICE is the only ACP service (acpx env)", () => {
    // Regression: before the swap, ACP_SUBPROCESS_SERVICE was checked
    // before PTY_SERVICE. With `acpx` installed and AcpService
    // registering cleanly, the planner would route to ACP and either
    // succeed via acpx OR fail with ENOENT — bypassing the orchestrator
    // path that ALL the per-adapter brief / AGENTS.md write logic lives in.
    const runtime = buildRuntime({
      PTY_SERVICE: PTY,
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(PTY);
  });
});
