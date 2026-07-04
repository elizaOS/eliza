/**
 * MCP provider tests.
 *
 * Guards #12744 (#12275-G fallback-slop sweep): a McpService read failure
 * inside the provider `get()` must render a distinguishable "status
 * unavailable" degrade line — never the designed "No MCP servers are
 * available." empty state — and must surface the underlying error via
 * `runtime.reportError` so it is observable in RECENT_ERRORS /
 * owner-escalation instead of being silently swallowed.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { provider } from "../src/provider";
import { MCP_SERVICE_NAME } from "../src/types";

const message = { id: "m", content: { text: "" } } as unknown as Memory;
const state = {} as State;

function runtimeWith(
  service: Record<string, unknown> | undefined,
  reportError = vi.fn()
): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => (name === MCP_SERVICE_NAME ? service : undefined)),
    reportError,
  } as unknown as IAgentRuntime;
}

describe("MCP provider", () => {
  it("returns the designed empty state when the service is absent", async () => {
    const reportError = vi.fn();
    const result = await provider.get(runtimeWith(undefined, reportError), message, state);
    expect(result.text).toBe("No MCP servers are available.");
    // Designed absence is not a failure — nothing to report.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("summarizes connected servers on success", async () => {
    const service = {
      getProviderData: vi.fn(() => ({
        values: {
          mcp: {
            "srv-a": {
              status: "connected",
              tools: { toolOne: {} },
              resources: {},
            },
          },
        },
        data: {
          mcp: {
            "srv-a": {
              status: "connected",
              tools: { toolOne: {} },
              resources: {},
            },
          },
        },
      })),
    };
    const result = await provider.get(runtimeWith(service), message, state);
    expect(result.text).toContain("srv-a");
    expect(result.text).toContain("toolOne");
    expect(result.data).toMatchObject({
      mcpServerCount: 1,
      shownMcpServerCount: 1,
    });
  });

  it("renders a distinguishable degrade and reports when reading MCP state fails", async () => {
    const boom = new Error("provider data unavailable");
    const reportError = vi.fn();
    const service = {
      getProviderData: vi.fn(() => {
        throw boom;
      }),
    };

    const result = await provider.get(runtimeWith(service, reportError), message, state);

    // NOT the designed "No MCP servers are available." empty state: a broken
    // MCP subsystem must be distinguishable from a clean no-servers world.
    expect(result.text).not.toBe("No MCP servers are available.");
    expect(result.text).toContain("unavailable");
    expect(result.text).toContain("provider data unavailable");
    expect(result.data).toMatchObject({ error: "provider data unavailable" });
    // The failure is observable in RECENT_ERRORS / owner-escalation.
    expect(reportError).toHaveBeenCalledWith("MCP.provider", boom);
  });
});
