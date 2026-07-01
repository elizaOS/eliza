import { describe, expect, it } from "vitest";
import { shouldRegisterSubAgentCredentialsPlugin } from "./sub-agent-credentials-runtime-policy.ts";

describe("shouldRegisterSubAgentCredentialsPlugin", () => {
  it("registers on parent runtimes", () => {
    expect(shouldRegisterSubAgentCredentialsPlugin({})).toBe(true);
  });

  it("does not auto-enable inside spawned sandbox child runtimes", () => {
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        SANDBOX_AGENT_ID: "sandbox-1",
      }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        SANDBOX_ROUTE_AGENT_ID: "character-1",
      }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        SANDBOX_SERVER_NAME: "worker-1",
      }),
    ).toBe(false);
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        PARALLAX_SESSION_ID: "pty-1-child",
      }),
    ).toBe(false);
  });

  it("does not treat bare cloud provisioning as a child-runtime marker", () => {
    expect(
      shouldRegisterSubAgentCredentialsPlugin({
        ELIZA_CLOUD_PROVISIONED: "1",
      }),
    ).toBe(true);
  });
});
