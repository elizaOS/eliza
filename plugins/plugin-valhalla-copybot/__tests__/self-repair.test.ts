import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/net.ts";
import {
  CircuitBreaker,
  classifyIncident,
  confirmRepair,
  crashRecoveryAllowed,
  failover,
  healthScore,
  proposeFix,
  reconcileAmount,
  reconcileIds,
  SignatureGuard,
  stageExpired,
} from "../src/self-repair.ts";

describe("self-repair", () => {
  it("times out a hung RPC and fails over", async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, "rpc")).rejects.toThrow(/timed out/);
    const hit = await failover(
      ["primary", "backup"],
      async (provider) => {
        if (provider === "primary") return new Promise(() => undefined);
        return "ok";
      },
      30
    );
    expect(hit.provider).toBe("backup");
    expect(hit.failed).toEqual(["primary"]);
    expect(stageExpired({ stage: "rpc", startedAt: 0, limitMs: 10 }, 11)).toBe(true);
  });

  it("treats a dropped stream as unknown, not an empty book", () => {
    const book = reconcileIds(["pos-1"], "error");
    expect(book.ids).toBe("unknown");
    expect(book.mismatch).toBe(true);
    const report = classifyIncident(["websocket dropped"]);
    expect(report.kind).toBe("dropped_ws");
    expect(report.report).toMatch(/not treat the book as empty|Do not treat the book as empty/);
  });

  it("blocks a second send after a timed-out send lands", () => {
    const guard = new SignatureGuard();
    expect(guard.track("sig-landed")).toBe("new");
    expect(guard.track("sig-landed")).toBe("duplicate");
    const proposal = proposeFix(["send timed out then signature landed"]);
    expect(proposal.action).toBe("pause_buys");
    expect(proposal.applied).toBe(false);
  });

  it("keeps a balance error as unknown and opens the breaker", () => {
    expect(reconcileAmount("error")).toBe("unknown");
    expect(reconcileAmount(null)).toBe("unknown");
    expect(reconcileAmount(0)).toBe(0);
    const breaker = new CircuitBreaker(2, 1_000);
    breaker.fail(0);
    breaker.fail(0);
    expect(breaker.allow(0)).toBe(false);
    const before = healthScore({
      stalled: true,
      breakerOpen: true,
      unknownBalance: true,
      mismatch: false,
      providerFails: 2,
    });
    const after = healthScore({
      stalled: false,
      breakerOpen: false,
      unknownBalance: false,
      mismatch: false,
      providerFails: 0,
    });
    expect(before.score).toBeLessThan(after.score);
    expect(after.label).toBe("healthy");
  });

  it("restarts only when flat and idle, and never applies a code change", () => {
    expect(crashRecoveryAllowed(1, 0).ok).toBe(false);
    expect(crashRecoveryAllowed(0, 1).ok).toBe(false);
    expect(crashRecoveryAllowed(0, 0).ok).toBe(true);
    const code = proposeFix(["please patch the source in a pull request"]);
    expect(code.action).toBe("code_change");
    expect(confirmRepair(code, true, 0, 0).applied).toBe(false);
    const refused = proposeFix(["disable the safety checks and withdraw"]);
    expect(refused.action).toBe("refused");
    const timeout = proposeFix(["rpc timed out"]);
    expect(timeout.needsConfirm).toBe(true);
    expect(confirmRepair(timeout, false, 0, 0).applied).toBe(false);
    expect(confirmRepair(timeout, true, 0, 0).applied).toBe(true);
    const restart = proposeFix(["something odd"]);
    expect(confirmRepair(restart, true, 2, 0).applied).toBe(false);
    expect(confirmRepair(restart, true, 0, 0).applied).toBe(true);
  });
});
