/**
 * Pure runtime-target mapping coverage for persisted local, remote, and Cloud
 * selections, including the native IPC record used by mobile local mode.
 */
import { describe, expect, it } from "vitest";
import { IOS_LOCAL_AGENT_IPC_BASE } from "./mobile-runtime-mode";
import {
  activeServerKindToFirstRunRuntimeTarget,
  activeServerToStartupRuntimeTarget,
  isElizaCloudFirstRunTarget,
  isMobileLocalActiveServer,
  resolveFirstRunLocalAgentApiBase,
} from "./runtime-target";

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
    const mobileServer = {
      id: "local:mobile",
      kind: "remote" as const,
      label: "On-device agent",
      apiBase: IOS_LOCAL_AGENT_IPC_BASE,
    };

    expect(isMobileLocalActiveServer(mobileServer)).toBe(true);
    expect(activeServerToStartupRuntimeTarget(mobileServer)).toBe(
      "embedded-local",
    );
  });

  it.each([
    ["local", "local"],
    ["cloud", "elizacloud"],
    ["remote", "remote"],
  ] as const)(
    "maps persisted %s kinds back to first-run target %s",
    (kind, expected) => {
      expect(activeServerKindToFirstRunRuntimeTarget(kind)).toBe(expected);
    },
  );

  it("identifies both managed Cloud first-run modes", () => {
    expect(isElizaCloudFirstRunTarget("elizacloud")).toBe(true);
    expect(isElizaCloudFirstRunTarget("elizacloud-hybrid")).toBe(true);
    expect(isElizaCloudFirstRunTarget("local")).toBe(false);
    expect(isElizaCloudFirstRunTarget("remote")).toBe(false);
  });

  it("uses a concrete local API base when no native IPC platform is active", () => {
    expect(resolveFirstRunLocalAgentApiBase()).toMatch(
      /^(https?:\/\/|eliza-local-agent:\/\/)/,
    );
  });
});
