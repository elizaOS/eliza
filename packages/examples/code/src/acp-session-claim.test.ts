/** Exercises authenticated warm-child claims without starting a runtime or exposing live credentials. */

import { describe, expect, it } from "bun:test";
import { delimiter } from "node:path";
import { AcpWarmSessionClaim } from "./acp-session-claim";

describe("AcpWarmSessionClaim", () => {
  it("applies one authenticated environment and clears every claimed value", () => {
    const target: Record<string, string | undefined> = {};
    const claim = new AcpWarmSessionClaim("claim-secret");

    claim.apply(
      {
        elizaSessionClaim: {
          token: "claim-secret",
          env: {
            ORCHESTRATOR_SESSION_ID: "session-a",
            OPENAI_API_KEY: "lease-a",
            PATH: "/caller-controlled/bin",
          },
          executionPath: ["/trusted/session-git/bin", "/usr/bin"].join(
            delimiter,
          ),
        },
      },
      target,
    );
    expect(target).toEqual({
      ORCHESTRATOR_SESSION_ID: "session-a",
      OPENAI_API_KEY: "lease-a",
      PATH: ["/trusted/session-git/bin", "/usr/bin"].join(delimiter),
    });
    expect(() =>
      claim.apply(
        {
          elizaSessionClaim: {
            token: "claim-secret",
            env: { ORCHESTRATOR_SESSION_ID: "session-b" },
            executionPath: "/usr/bin",
          },
        },
        target,
      ),
    ).toThrow("already consumed");

    claim.clear(target);
    expect(target).toEqual({});
  });

  it("rejects wrong tokens and invalid entries without partially mutating env", () => {
    for (const attempted of [
      { token: "wrong-secret", env: { OPENAI_API_KEY: "lease-b" } },
      {
        token: "claim-secret",
        env: {
          OPENAI_API_KEY: "lease-b",
          ELIZA_ACP_WARM_CLAIM_TOKEN: "replace-authenticator",
        },
        executionPath: "/usr/bin",
      },
      {
        token: "claim-secret",
        env: { "mixed-Case": "lease-b" },
        executionPath: "/usr/bin",
      },
      {
        token: "claim-secret",
        env: { OPENAI_API_KEY: "lease-b" },
        executionPath: "relative/bin",
      },
    ]) {
      const target = { EXISTING: "preserved" };
      const claim = new AcpWarmSessionClaim("claim-secret");
      expect(() =>
        claim.apply({ elizaSessionClaim: attempted }, target),
      ).toThrow();
      expect(target).toEqual({ EXISTING: "preserved" });
      expect(claim.wasConsumed).toBe(false);
    }
  });

  it("rejects claim material when the child was not pre-authorized", () => {
    const claim = new AcpWarmSessionClaim();
    expect(() =>
      claim.apply({
        elizaSessionClaim: {
          token: "injected",
          env: { OPENAI_API_KEY: "lease" },
          executionPath: "/usr/bin",
        },
      }),
    ).toThrow("unexpected warm-session claim");
  });
});
