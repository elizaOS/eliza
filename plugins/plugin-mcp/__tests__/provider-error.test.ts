/**
 * Failure-path test for the MCP provider: when the service's getProviderData
 * throws, the provider must surface the failure via runtime.reportError and
 * render a distinguishable error state, never mask it as a healthy "no servers"
 * result (error-policy J7, #12744).
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { provider } from "../src/provider.js";
import { MCP_SERVICE_NAME } from "../src/types.js";

const HEALTHY_EMPTY = "No MCP servers are available.";

function runtimeWithService(service: unknown, reportError: () => void): IAgentRuntime {
  return {
    getService: (name: string) => (name === MCP_SERVICE_NAME ? service : undefined),
    reportError,
  } as unknown as IAgentRuntime;
}

describe("MCP provider failure path", () => {
  it("reports the failure and does not render a healthy-empty result when getProviderData throws", async () => {
    const boom = new Error("provider data unavailable");
    const service = {
      getProviderData: () => {
        throw boom;
      },
    };
    const reportError = vi.fn();
    const runtime = runtimeWithService(service, reportError);

    const result = await provider.get(runtime, {} as Memory, {} as State);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("MCP.provider", boom);
    expect(result.text).not.toBe(HEALTHY_EMPTY);
    expect(result.data?.error).toBe("provider data unavailable");
  });

  it("renders the healthy-empty result only when the service is genuinely absent", async () => {
    const reportError = vi.fn();
    const runtime = {
      getService: () => undefined,
      reportError,
    } as unknown as IAgentRuntime;

    const result = await provider.get(runtime, {} as Memory, {} as State);

    expect(reportError).not.toHaveBeenCalled();
    expect(result.text).toBe(HEALTHY_EMPTY);
  });
});
