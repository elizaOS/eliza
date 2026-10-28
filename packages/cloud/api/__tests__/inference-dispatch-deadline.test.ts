/** Exercises the production dispatch client with deterministic binding delay; no database, provider or account changes are performed. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type InferenceAdmissionLease,
  markInferenceAdmissionLeaseDispatched,
} from "@elizaos/cloud-shared/lib/services/inference-admission-gate";

let now = 0;
let budgets: number[] = [];
let latestBudget = 0;
let restoreClock: () => void;
let restoreTimeout: () => void;
beforeEach(() => {
  now = 0;
  budgets = [];
  const timeSpy = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => timeSpy.mockRestore();
  const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
    (ms: number) => {
      latestBudget = ms;
      budgets.push(ms);
      return new AbortController().signal;
    },
  );
  restoreTimeout = () => timeoutSpy.mockRestore();
});
afterEach(() => {
  restoreClock();
  restoreTimeout();
});
function ack() {
  return Response.json({
    admitted: true,
    dispatched: true,
    availableUsd: 9,
    requiredUsd: 1,
  });
}
function lease(
  fetch: (request: Request) => Promise<Response>,
): InferenceAdmissionLease {
  return {
    organizationId: "org-a",
    requestId: "request-a",
    estimatedCostUsd: 1,
    providerDispatched: false,
    preProviderCancellationToken: "capability-a",
    gate: { fetch } as never,
    preparedDispatch: {
      path: "/lease-dispatched",
      state: "prepared",
      body: {
        organizationId: "org-a",
        requestId: "request-a",
        estimatedCostUsd: 1,
      },
    },
  };
}
function consume(ms: number) {
  const allowed = latestBudget;
  now += Math.min(ms, allowed);
  if (ms > allowed) throw new DOMException("deadline", "TimeoutError");
}
describe("one total dispatch deadline", () => {
  test("allows delayed handler entry once within the existing total budget", async () => {
    let calls = 0;
    const l = lease(async () => {
      calls++;
      consume(2505);
      return ack();
    });
    await markInferenceAdmissionLeaseDispatched(l);
    expect(calls).toBe(1);
    expect(now).toBe(2505);
    expect(budgets).toEqual([4500]);
    expect(l.providerDispatched).toBe(true);
    expect(l.preProviderCancellationToken).toBeUndefined();
  });
  test("fast transport failure retries only the remaining budget", async () => {
    let calls = 0;
    const l = lease(async () => {
      calls++;
      consume(calls === 1 ? 125 : 20);
      if (calls === 1) throw Error("binding unavailable");
      return ack();
    });
    await markInferenceAdmissionLeaseDispatched(l);
    expect(calls).toBe(2);
    expect(budgets).toEqual([4500, 4375]);
    expect(l.providerDispatched).toBe(true);
  });
  test("an ambiguous committed response reuses exactly one request and capability", async () => {
    const bodies: unknown[] = [];
    const committed = new Set<string>();
    let accountingCommits = 0;
    const l = lease(async (request) => {
      const body = (await request.json()) as { requestId: string };
      bodies.push(body);
      consume(50);
      if (!committed.has(body.requestId)) {
        committed.add(body.requestId);
        accountingCommits++;
        return new Response("{");
      }
      return ack();
    });
    await markInferenceAdmissionLeaseDispatched(l);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(accountingCommits).toBe(1);
    expect(l.providerDispatched).toBe(true);
  });
  test("exhaustion never starts a third attempt or loses the ambiguous cancellation capability", async () => {
    let calls = 0;
    const l = lease(async () => {
      calls++;
      if (calls === 1) {
        consume(4400);
        throw Error("fast failure late in window");
      }
      consume(200);
      return ack();
    });
    await expect(markInferenceAdmissionLeaseDispatched(l)).rejects.toThrow(
      "ambiguous after 2 attempts",
    );
    expect(now).toBe(4500);
    expect(calls).toBe(2);
    expect(budgets).toEqual([4500, 100]);
    expect(l.providerDispatched).toBe(false);
    expect(l.preProviderCancellationToken).toBe("capability-a");
    expect(l.preparedDispatch?.state).toBe("ambiguous");
  });
  test("three immediate failures retain the existing attempt limit", async () => {
    let calls = 0;
    const l = lease(async () => {
      calls++;
      consume(5);
      throw Error("binding failed");
    });
    await expect(markInferenceAdmissionLeaseDispatched(l)).rejects.toThrow(
      "ambiguous after 3 attempts",
    );
    expect(calls).toBe(3);
  });
  test.each([402, 403, 409])(
    "terminal %i remains a single attempt with no dispatch",
    async (status) => {
      let calls = 0;
      const l = lease(async () => {
        calls++;
        return Response.json(
          {
            admitted: false,
            availableUsd: 0,
            requiredUsd: 1,
            reason: "revoked",
            code: "inference_admission_policy_stale",
          },
          { status },
        );
      });
      await expect(markInferenceAdmissionLeaseDispatched(l)).rejects.toThrow();
      expect(calls).toBe(1);
      expect(l.providerDispatched).toBe(false);
      expect(l.preProviderCancellationToken).toBe("capability-a");
    },
  );
});
