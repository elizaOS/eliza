/** Exercises authenticated warm-child claims without starting a runtime or exposing live credentials. */
import { describe, expect, it } from "bun:test";
import { AcpWarmSessionClaim } from "./acp-session-claim";

describe("AcpWarmSessionClaim", () => {
  it("applies one authenticated environment and clears every claimed value", () => {
    const source = { ELIZA_ACP_WARM_CLAIM_TOKEN: "claim-secret", PATH: "/bin" };
    const target: Record<string, string | undefined> = {};
    const claim = new AcpWarmSessionClaim(source);

    expect(source.ELIZA_ACP_WARM_CLAIM_TOKEN).toBeUndefined();
    claim.apply(
      {
        elizaSessionClaim: {
          token: "claim-secret",
          env: {
            ORCHESTRATOR_SESSION_ID: "session-a",
            OPENAI_API_KEY: "lease-a",
          },
        },
      },
      target,
    );
    expect(target).toEqual({
      ORCHESTRATOR_SESSION_ID: "session-a",
      OPENAI_API_KEY: "lease-a",
    });
    expect(() =>
      claim.apply(
        {
          elizaSessionClaim: {
            token: "claim-secret",
            env: { ORCHESTRATOR_SESSION_ID: "session-b" },
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
      },
      { token: "claim-secret", env: { "mixed-Case": "lease-b" } },
    ]) {
      const target = { EXISTING: "preserved" };
      const claim = new AcpWarmSessionClaim({
        ELIZA_ACP_WARM_CLAIM_TOKEN: "claim-secret",
      });
      expect(() =>
        claim.apply({ elizaSessionClaim: attempted }, target),
      ).toThrow();
      expect(target).toEqual({ EXISTING: "preserved" });
      expect(claim.wasConsumed).toBe(false);
    }
  });

  it("rejects claim material when the child was not pre-authorized", () => {
    const claim = new AcpWarmSessionClaim({});
    expect(() =>
      claim.apply({
        elizaSessionClaim: {
          token: "injected",
          env: { OPENAI_API_KEY: "lease" },
        },
      }),
    ).toThrow("unexpected warm-session claim");
  });
});
