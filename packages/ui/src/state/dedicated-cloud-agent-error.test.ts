/**
 * Tests for dedicated-cloud-agent-error — isTerminalDedicatedCloudAgentErrorState.
 */
import { describe, expect, it } from "vitest";
import { isTerminalDedicatedCloudAgentErrorState } from "./dedicated-cloud-agent-error.ts";

describe("dedicated-cloud-agent-error", () => {
  it("returns true for agent_error_state on dedicated base", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 503,
        code: "agent_error_state",
        message: "ok",
        clientBaseUrl: "https://agent-1.eliza.app",
      }),
    ).toBe(true);
  });

  it("returns false for non-503", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 500,
        code: "agent_error_state",
        message: "ok",
        clientBaseUrl: "https://agent-1.eliza.app",
      }),
    ).toBe(false);
  });

  it("returns false for non-dedicated base", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 503,
        code: "agent_error_state",
        message: "ok",
        clientBaseUrl: "https://example.com",
      }),
    ).toBe(false);
  });

  it("matches legacy error state fragment", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 503,
        message: "Agent is in an error state",
        clientBaseUrl: "https://agent-1.eliza.app",
      }),
    ).toBe(true);
  });

  it("matches agent_not_running with control plane status", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 503,
        code: "agent_not_running",
        message: "x",
        data: { data: { status: "stopped" } },
        clientBaseUrl: "https://agent-1.eliza.app",
      }),
    ).toBe(true);
  });

  it("returns false when no match", () => {
    expect(
      isTerminalDedicatedCloudAgentErrorState({
        status: 503,
        code: "unknown",
        message: "nope",
        clientBaseUrl: "https://agent-1.eliza.app",
      }),
    ).toBe(false);
  });
});
