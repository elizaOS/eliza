/**
 * Pure runtime-target mapping coverage for persisted local, remote, and Cloud
 * selections, including the native IPC record used by mobile local mode.
 */
import { describe, expect, it } from "vitest";
import { IOS_LOCAL_AGENT_IPC_BASE } from "./mobile-runtime-mode";
import { activeServerToStartupRuntimeTarget } from "./runtime-target";

describe("active server startup target", () => {
  it.each([
    ["local", undefined, "embedded-local"],
    [
      "cloud",
      "https://elizacloud.ai/api/v1/eliza/agents/agent-1",
      "cloud-managed",
    ],
    ["remote", "https://agent.example.com", "remote-backend"],
  ] as const)("maps %s at %s to %s", (kind, apiBase, expected) => {
    expect(
      activeServerToStartupRuntimeTarget({
        id: `${kind}:test`,
        kind,
        label: "Test",
        ...(apiBase ? { apiBase } : {}),
      }),
    ).toBe(expected);
  });

  it("treats the remote-shaped mobile IPC profile as embedded local", () => {
    expect(
      activeServerToStartupRuntimeTarget({
        id: "local:mobile",
        kind: "remote",
        label: "On-device agent",
        apiBase: IOS_LOCAL_AGENT_IPC_BASE,
      }),
    ).toBe("embedded-local");
  });
});
