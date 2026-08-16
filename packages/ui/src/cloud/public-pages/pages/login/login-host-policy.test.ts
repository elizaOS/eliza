/**
 * Host routing contract for the public login page. The matrix uses the shared
 * domain classifiers directly and performs no rendering or network access.
 */
import { describe, expect, it } from "vitest";
import { resolveLoginHostMode } from "./login-host-policy";

describe("resolveLoginHostMode", () => {
  it.each([
    "cloud.eliza.app",
    "CLOUD.ELIZA.APP",
    "cloud.eliza.app.",
    "cloud-staging.eliza.app",
    "app.elizacloud.ai",
    "app-staging.elizacloud.ai",
  ])("renders passwordless login on app host %s", (hostname) => {
    expect(resolveLoginHostMode(hostname)).toBe("same-origin");
  });

  it.each([
    "agent-1.cloud.eliza.app",
    "agent-1.cloud-staging.eliza.app",
    "agent-1.elizacloud.ai",
  ])("retains SSO handoff on dedicated host %s", (hostname) => {
    expect(resolveLoginHostMode(hostname)).toBe("sso-handoff");
  });

  it.each(["eliza.app", "staging.eliza.app", "localhost", "example.test"])(
    "renders the public login on non-managed host %s",
    (hostname) => {
      expect(resolveLoginHostMode(hostname)).toBe("same-origin");
    },
  );

  it("does not mistake a dedicated-host suffix lookalike for a handoff host", () => {
    expect(resolveLoginHostMode("agent-1.cloud.eliza.app.evil.test")).toBe(
      "same-origin",
    );
  });
});
