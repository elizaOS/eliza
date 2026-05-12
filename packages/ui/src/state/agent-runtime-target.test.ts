import { describe, expect, it } from "vitest";
import {
  inferAgentRuntimeTarget,
  isLocalAgentApiBase,
} from "./agent-runtime-target";
import type { PersistedActiveServer } from "./persistence";

describe("inferAgentRuntimeTarget", () => {
  it("treats persisted cloud agents as cloud even when mobile mode is absent", () => {
    const activeServer: PersistedActiveServer = {
      id: "cloud:agent-123",
      kind: "cloud",
      label: "Trading bot",
      apiBase: "https://agent.example.com",
    };

    expect(
      inferAgentRuntimeTarget({
        activeServer,
        mobileRuntimeMode: null,
        clientBaseUrl: activeServer.apiBase,
      }),
    ).toEqual({ kind: "cloud", label: "Trading bot" });
  });

  it("detects desktop local agents persisted as remote loopback servers", () => {
    const activeServer: PersistedActiveServer = {
      id: "local:desktop",
      kind: "remote",
      label: "On-device agent",
      apiBase: "http://127.0.0.1:31337",
    };

    expect(
      inferAgentRuntimeTarget({
        activeServer,
        mobileRuntimeMode: null,
        clientBaseUrl: activeServer.apiBase,
      }).kind,
    ).toBe("local");
  });

  it("defaults to remote for non-local remote API bases", () => {
    expect(
      inferAgentRuntimeTarget({
        activeServer: {
          id: "remote:https://mac.local:31337",
          kind: "remote",
          label: "Studio Mac",
          apiBase: "https://mac.local:31337",
        },
        mobileRuntimeMode: null,
      }),
    ).toEqual({ kind: "remote", label: "Studio Mac" });
  });
});

describe("isLocalAgentApiBase", () => {
  it("recognizes loopback API bases", () => {
    expect(isLocalAgentApiBase("http://localhost:31337/")).toBe(true);
    expect(isLocalAgentApiBase("http://127.0.0.1:2138")).toBe(true);
    expect(isLocalAgentApiBase("https://remote.example.com")).toBe(false);
  });
});
