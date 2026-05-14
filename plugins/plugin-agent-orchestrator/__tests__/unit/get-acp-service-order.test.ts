import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { getAcpService } from "../../src/actions/common.ts";

/** Pins the ACP-only resolution order used by TASKS after the acpx cleanup. */
describe("getAcpService resolution order", () => {
  function buildRuntime(services: Record<string, unknown>): IAgentRuntime {
    return {
      getService: vi.fn((key: string) => services[key] ?? null),
    } as unknown as IAgentRuntime;
  }

  const ACP_SUB = { kind: "ACP_SUBPROCESS" } as const;
  const ACP = { kind: "ACP" } as const;

  it("returns ACP_SERVICE first when both ACP services are registered", () => {
    const runtime = buildRuntime({
      ACP_SERVICE: ACP,
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(ACP);
  });

  it("falls back to ACP_SUBPROCESS_SERVICE when ACP_SERVICE is absent", () => {
    const runtime = buildRuntime({
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(ACP_SUB);
  });

  it("returns undefined when no relevant service is registered", () => {
    const runtime = buildRuntime({});
    expect(getAcpService(runtime)).toBeUndefined();
  });

  it("ignores removed PTY_SERVICE registrations", () => {
    const runtime = buildRuntime({
      PTY_SERVICE: { kind: "PTY" },
      ACP_SUBPROCESS_SERVICE: ACP_SUB,
    });
    expect(getAcpService(runtime)).toBe(ACP_SUB);
  });
});
