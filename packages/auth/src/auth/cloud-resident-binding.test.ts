import { describe, expect, it } from "vitest";
import {
  CloudResidentBindingController,
  CloudResidentBindingError,
  type CloudResidentBindingPorts,
  OFFLINE_PLAN_GRACE_MS,
  parseResidentPlanAdmission,
  type ResidentIdentity,
  type ResidentPlanAdmissionRecord,
  type ResidentPlanCheck,
  recentResidentPlanAdmission,
} from "./cloud-resident-binding.ts";

const NOW = 1_800_000_000_000;
const USER = "9f1dc45a-4011-4e44-947a-30d999d24fa5";
class Unreachable extends Error {}
class Rejected extends Error {}
class StopUnconfirmed extends Error {}

type Env = "production" | "staging";
const active: ResidentPlanCheck<string> = {
  decision: "admit",
  view: "active",
  outage: false,
  record: { status: "active", planName: "Plus" },
  endsAt: NOW + 86_400_000,
};

function harness(
  overrides: Partial<CloudResidentBindingPorts<string, Env>> = {},
) {
  const calls: string[] = [];
  const state = {
    credential: { credentialId: "cred-a" } as { credentialId: string } | null,
    record: null as ResidentPlanAdmissionRecord<Env> | null,
    plan: active as ResidentPlanCheck<string> | Error,
    identity: { credentialId: "cred-a", userId: USER, organizationId: null } as
      | ResidentIdentity
      | Error,
    bind: null as Error | null,
    clear: null as Error | null,
    now: NOW,
  };
  const ports: CloudResidentBindingPorts<string, Env> = {
    readCredential: async () => state.credential,
    verifyIdentity: async () => {
      calls.push("identity");
      if (state.identity instanceof Error) throw state.identity;
      return state.identity;
    },
    checkPlan: async () => {
      calls.push("plan");
      if (state.plan instanceof Error) throw state.plan;
      return state.plan;
    },
    bindProvider: async (credentialId) => {
      calls.push(`bind ${credentialId}`);
      if (state.bind) throw state.bind;
    },
    clearProvider: async (_signal, reason) => {
      calls.push(reason === "unbound" ? "clear" : "clear after failed bind");
      if (state.clear) throw state.clear;
    },
    readAdmission: () => state.record,
    writeAdmission: (record) => {
      calls.push(record ? `record ${record.status}` : "record cleared");
      state.record = record;
    },
    isUnreachable: (error) => error instanceof Unreachable,
    isSignInRejected: (error) => error instanceof Rejected,
    isFatalBindError: (error) => error instanceof StopUnconfirmed,
    now: () => state.now,
    ...overrides,
  };
  return {
    calls,
    state,
    controller: new CloudResidentBindingController<string, Env>(
      "production",
      ports,
    ),
  };
}
const signal = () => new AbortController().signal;
const record = (
  patch: Partial<ResidentPlanAdmissionRecord<Env>> = {},
): ResidentPlanAdmissionRecord<Env> => ({
  version: 1,
  environment: "production",
  credentialId: "cred-a",
  userId: USER,
  organizationId: null,
  status: "active",
  planName: "Plus",
  verifiedAt: NOW - 1000,
  endsAt: null,
  ...patch,
});

describe("resident Cloud binding admission", () => {
  it("leaves inference unbound without a saved sign-in and reads nothing else", async () => {
    const { controller, state, calls } = harness();
    state.credential = null;
    expect(await controller.admit(signal())).toEqual({
      binding: "unbound",
      reason: "signed-out",
    });
    expect(calls).toEqual([]);
  });

  it("admits an active plan, records it for the offline rule and binds the same credential", async () => {
    const { controller, state, calls } = harness();
    const admission = await controller.admit(signal());
    expect(admission).toMatchObject({
      binding: "cloud",
      reason: "admitted",
      endsAt: NOW + 86_400_000,
    });
    expect(state.record).toMatchObject({
      credentialId: "cred-a",
      status: "active",
      verifiedAt: NOW,
    });
    expect(await controller.apply(admission, signal())).toEqual({
      binding: "cloud",
    });
    expect(calls).toEqual(["identity", "plan", "record active", "bind cred-a"]);
  });

  it("refuses an account that changed between reads and while binding", async () => {
    const { controller, state } = harness({
      checkPlan: async () => {
        state.credential = { credentialId: "cred-b" };
        return active;
      },
    });
    const changed = await controller.admit(signal());
    expect(changed).toMatchObject({
      binding: "unbound",
      reason: "account-changed",
    });
    expect(changed.error).toBeInstanceOf(CloudResidentBindingError);

    const second = harness();
    const admission = await second.controller.admit(signal());
    second.state.credential = { credentialId: "cred-b" };
    // The bind is cleared rather than left on another account's credential.
    expect(await second.controller.apply(admission, signal())).toMatchObject({
      binding: "unbound",
      failure: { kind: "bind-failed" },
    });
    expect(second.calls.slice(-2)).toEqual([
      "bind cred-a",
      "clear after failed bind",
    ]);

    const mismatch = harness();
    mismatch.state.identity = {
      credentialId: "cred-other",
      userId: USER,
      organizationId: null,
    };
    expect(await mismatch.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "account-changed",
    });
  });

  it("unbinds a rejected or revoked sign-in", async () => {
    const identity = harness();
    identity.state.identity = new Rejected("401");
    expect(await identity.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "sign-in-rejected",
    });
    const plan = harness();
    plan.state.plan = new Rejected("revoked");
    expect(await plan.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "sign-in-rejected",
    });
    expect(plan.calls).not.toContain("record active");
  });

  it("forgets a plan that ended and leaves inference unbound", async () => {
    const { controller, state, calls } = harness();
    state.record = record();
    state.plan = {
      decision: "needs-plan",
      view: "inactive",
      outage: false,
      record: null,
    };
    const admission = await controller.admit(signal());
    expect(admission).toMatchObject({
      binding: "unbound",
      reason: "needs-plan",
      endsAt: null,
    });
    expect(state.record).toBeNull();
    expect(await controller.apply(admission, signal())).toEqual({
      binding: "unbound",
    });
    expect(calls).toContain("record cleared");
    expect(calls.at(-1)).toBe("clear");
  });

  it("keeps a recent verified plan while Cloud is unreachable, for seven days and never past its end", async () => {
    const kept = harness();
    kept.state.record = record();
    kept.state.identity = new Unreachable("offline");
    const admission = await kept.controller.admit(signal());
    expect(admission).toMatchObject({ binding: "kept", reason: "offline" });
    expect(await kept.controller.apply(admission, signal())).toEqual({
      binding: "kept",
    });
    expect(kept.calls).toEqual(["identity"]);

    for (const stale of [
      record({ verifiedAt: NOW - OFFLINE_PLAN_GRACE_MS - 1 }),
      record({ endsAt: NOW - 1 }),
      record({ credentialId: "cred-b" }),
      record({ environment: "staging" }),
      record({ verifiedAt: NOW + 60_000 }),
    ]) {
      const unbound = harness();
      unbound.state.record = stale;
      unbound.state.identity = new Unreachable("offline");
      expect(await unbound.controller.admit(signal())).toMatchObject({
        binding: "unbound",
        reason: "offline",
        recent: null,
      });
    }

    const midway = harness();
    midway.state.record = record({ userId: "someone-else" });
    midway.state.plan = new Unreachable("billing offline");
    expect(await midway.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "offline",
    });
  });

  it("admits through a billing outage only for a recent verified plan", async () => {
    const outage: ResidentPlanCheck<string> = {
      decision: "unknown",
      view: "outage",
      outage: true,
      record: null,
    };
    const recent = harness();
    recent.state.record = record({ status: "past_due", endsAt: NOW + 5000 });
    recent.state.plan = outage;
    expect(await recent.controller.admit(signal())).toMatchObject({
      binding: "cloud",
      endsAt: NOW + 5000,
    });
    const none = harness();
    none.state.plan = outage;
    expect(await none.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "needs-plan",
    });
    expect(none.state.record).toBeNull();
    const failed = harness();
    failed.state.plan = new Error("malformed");
    expect(await failed.controller.admit(signal())).toMatchObject({
      binding: "unbound",
      reason: "plan-unavailable",
    });
  });

  it("reports an unconfirmed removal as unknown and rethrows a fatal bind error", async () => {
    const unconfirmed = harness();
    unconfirmed.state.clear = new Error("stop unconfirmed");
    expect(
      await unconfirmed.controller.apply({ binding: "unbound" }, signal()),
    ).toEqual({ binding: "unknown", failure: { kind: "unbind-unconfirmed" } });
    const failedBind = harness();
    failedBind.state.bind = new Error("provider refused");
    failedBind.state.clear = new Error("removal unconfirmed");
    const admission = await failedBind.controller.admit(signal());
    expect(
      (await failedBind.controller.apply(admission, signal())).binding,
    ).toBe("unknown");
    const fatal = harness();
    fatal.state.bind = new StopUnconfirmed("stop");
    await expect(
      fatal.controller.apply(await fatal.controller.admit(signal()), signal()),
    ).rejects.toBeInstanceOf(StopUnconfirmed);
    expect(fatal.calls.filter((call) => call.startsWith("clear"))).toEqual([]);
  });

  it("propagates cancellation instead of deciding a binding", async () => {
    const controller = new AbortController();
    const { controller: binding } = harness({
      verifyIdentity: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw new Unreachable("aborted request");
      },
    });
    await expect(binding.admit(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("resident Cloud binding coordination", () => {
  it("runs at most one rebind and queues one more behind it", async () => {
    const { controller } = harness();
    let release: () => void = () => {};
    let runs = 0;
    const rebind = () => {
      runs++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = controller.requestRebind(rebind);
    void controller.requestRebind(rebind);
    void controller.requestRebind(rebind);
    expect(runs).toBe(1);
    expect(controller.rebindPending).toBe(true);
    release();
    await first;
    await Promise.resolve();
    expect(runs).toBe(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toBe(2);
    expect(controller.rebindPending).toBe(false);
  });

  it("defers a rebind while the host is busy and resumes it once", async () => {
    const { controller } = harness();
    let busy = true;
    let runs = 0;
    const rebind = async () => {
      runs++;
    };
    await controller.requestRebind(rebind, () => busy);
    expect(runs).toBe(0);
    expect(controller.resumeQueued(rebind, () => busy)).toBeUndefined();
    busy = false;
    await controller.resumeQueued(rebind, () => busy);
    expect(runs).toBe(1);
    expect(controller.resumeQueued(rebind)).toBeUndefined();
  });

  it("allows one sign-in at a time and cancels it without touching the stored sign-in", async () => {
    const { controller, calls } = harness();
    const step = controller.beginSignIn(signal());
    expect(() => controller.beginSignIn(signal())).toThrow(
      CloudResidentBindingError,
    );
    expect(controller.signInActive).toBe(true);
    controller.cancelSignIn();
    expect(step.signal.aborted).toBe(true);
    step.end();
    expect(controller.signInActive).toBe(false);
    const outer = new AbortController();
    const next = controller.beginSignIn(outer.signal);
    outer.abort(new DOMException("closed", "AbortError"));
    expect(next.signal.aborted).toBe(true);
    next.end();
    expect(calls).toEqual([]);
    const aborted = new AbortController();
    aborted.abort();
    expect(() => controller.beginSignIn(aborted.signal)).toThrow();
    expect(controller.signInActive).toBe(false);
  });

  it("revokes the replaced key before storing the new one, and never blocks on revocation", async () => {
    const order: string[] = [];
    const store = (saved: string | null, revoke: () => Promise<boolean>) => ({
      read: async () => saved,
      same: (a: string, b: string) => a === b,
      revoke: async (previous: string) => {
        order.push(`revoke ${previous}`);
        return revoke();
      },
      write: async (issued: string) => {
        order.push(`write ${issued}`);
      },
    });
    expect(
      await CloudResidentBindingController.replaceCredential(
        store("old", async () => true),
        "new",
        signal(),
      ),
    ).toBe("revoked");
    expect(order).toEqual(["revoke old", "write new"]);
    order.length = 0;
    expect(
      await CloudResidentBindingController.replaceCredential(
        store("old", async () => {
          throw new Error("lost");
        }),
        "new",
        signal(),
      ),
    ).toBe("unconfirmed");
    expect(order).toEqual(["revoke old", "write new"]);
    order.length = 0;
    expect(
      await CloudResidentBindingController.replaceCredential(
        store("same", async () => true),
        "same",
        signal(),
      ),
    ).toBeUndefined();
    expect(
      await CloudResidentBindingController.replaceCredential(
        store(null, async () => true),
        "new",
        signal(),
      ),
    ).toBeUndefined();
    expect(order).toEqual(["write same", "write new"]);
    const cancelled = new AbortController();
    order.length = 0;
    await expect(
      CloudResidentBindingController.replaceCredential(
        {
          ...store("old", async () => {
            cancelled.abort();
            return true;
          }),
        },
        "new",
        cancelled.signal,
      ),
    ).rejects.toBeDefined();
    expect(order).toEqual(["revoke old"]);
  });
});

describe("plan admission records", () => {
  const allowed = (value: unknown): value is Env =>
    value === "production" || value === "staging";
  it("parses only well-formed records", () => {
    expect(parseResidentPlanAdmission(record(), allowed)).toEqual(record());
    expect(
      parseResidentPlanAdmission(
        { ...record(), endsAt: "soon", organizationId: 3 },
        allowed,
      ),
    ).toEqual(record({ endsAt: null, organizationId: null }));
    for (const bad of [
      null,
      [],
      { ...record(), version: 2 },
      { ...record(), environment: "dev" },
      { ...record(), status: "free" },
      { ...record(), verifiedAt: Number.NaN },
    ])
      expect(parseResidentPlanAdmission(bad, allowed)).toBeNull();
  });
  it("matches the user case-insensitively and only within the window", () => {
    expect(
      recentResidentPlanAdmission(
        record(),
        "production",
        "cred-a",
        USER.toUpperCase(),
        NOW,
      ),
    ).not.toBeNull();
    expect(
      recentResidentPlanAdmission(
        record(),
        "production",
        undefined,
        undefined,
        NOW,
      ),
    ).toBeNull();
    expect(
      recentResidentPlanAdmission(
        record({ verifiedAt: NOW - OFFLINE_PLAN_GRACE_MS }),
        "production",
        "cred-a",
        undefined,
        NOW,
      ),
    ).not.toBeNull();
  });
});
