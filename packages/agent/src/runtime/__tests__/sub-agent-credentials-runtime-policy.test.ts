import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  TRACE_ENV: { SESSION_ID: "ORCHESTRATOR_SESSION_ID" },
}));

import { shouldRegisterSubAgentCredentialsPlugin } from "./sub-agent-credentials-runtime-policy.ts";

describe("shouldRegisterSubAgentCredentialsPlugin", () => {
  it("returns true for a plain parent runtime", () => {
    expect(shouldRegisterSubAgentCredentialsPlugin({})).toBe(true);
    expect(shouldRegisterSubAgentCredentialsPlugin({ SOME_OTHER: "x" })).toBe(
      true,
    );
  });

  it("returns false when any child-runtime marker is set", () => {
    expect(
      shouldRegisterSubAgentCredentialsPlugin({ SANDBOX_AGENT_ID: "a" }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        SANDBOX_ROUTE_AGENT_ID: "r",
      }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({ SANDBOX_SERVER_NAME: "s" }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        ORCHESTRATOR_SESSION_ID: "o",
      }),
    ).toBe(false);
  });

  it("treats blank markers as unset", () => {
    expect(
      shouldRegisterSubAgentCredentialsPlugin({ SANDBOX_AGENT_ID: "  " }),
    ).toBe(true);
  });
});
