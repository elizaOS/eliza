import { describe, expect, it, vi } from "vitest";
import { activeSubAgentsProvider } from "../providers/active-sub-agents.ts";

const PROVIDER_NAME = "ACTIVE_SUB_AGENTS";

/** Minimal runtime: only the wave supervisor is registered, so the provider
 * takes its no-ACP-service path and exercises the wave-status read alone. */
function runtimeWithWaveSupervisor(getWaveStatuses: () => never | []): {
  runtime: unknown;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  const runtime = {
    getService: (serviceType: string) =>
      serviceType === "ORCHESTRATOR_WAVE_SUPERVISOR"
        ? { getWaveStatuses }
        : null,
    reportError,
  };
  return { runtime, reportError };
}

describe("ACTIVE_SUB_AGENTS wave status", () => {
  it("does not report a failed wave-status read as 'no waves'", async () => {
    const { runtime, reportError } = runtimeWithWaveSupervisor(() => {
      throw new Error("wave supervisor unavailable");
    });

    const result = await activeSubAgentsProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    // A thrown read must stay observable: reported and visibly marked in the
    // planner context, not silently collapsed into the empty wave list.
    expect(reportError).toHaveBeenCalledWith(PROVIDER_NAME, expect.any(Error), {
      operation: "getWaveStatuses",
    });
    expect(result.text).toContain("wave status unavailable");
    expect(
      (result.data as { wavesUnavailable?: boolean }).wavesUnavailable,
    ).toBe(true);
  });

  it("keeps an absent wave supervisor as a legitimate empty list", async () => {
    const runtime = {
      getService: () => null,
      reportError: vi.fn(),
    };

    const result = await activeSubAgentsProvider.get(
      runtime as never,
      {} as never,
      {} as never,
    );

    expect(result.text).toBe("");
    expect(
      (result.data as { wavesUnavailable?: boolean }).wavesUnavailable,
    ).toBe(false);
  });
});
