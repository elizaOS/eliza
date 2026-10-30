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
  ResidentRebindQueue,
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
    await expect(
      second.controller.apply(admission, signal()),
    ).rejects.toMatchObject({
      code: "account-changed",
    });
    expect(
      second.calls.filter(
        (call) => call.startsWith("bind") || call.startsWith("clear"),
      ),
    ).toEqual([]);

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

  it("does not clear a newer native binding after an older bind finishes", async () => {
    let credential = "cred-a";
    let provider = "cred-a";
    let nativeIntent = 0;
    const clears: number[] = [];
    const { controller } = harness({
      readCredential: async () => ({ credentialId: credential }),
      bindProvider: async () => {
        // Another Activity replaces the credential and binds it while the first
        // Activity's native result is in flight; its JS signal is not aborted.
        credential = "cred-b";
        provider = "cred-b";
        nativeIntent++;
      },
      clearProvider: async () => {
        // Alpha's clearProvider reserves a NEW intent on invocation. The native
        // last-intent fence therefore cannot identify this stale JS cleanup.
        clears.push(++nativeIntent);
        provider = "";
      },
    });
    const admission = await controller.admit(signal());
    await expect(controller.apply(admission, signal())).rejects.toMatchObject({
      code: "account-changed",
    });
    expect(provider).toBe("cred-b");
    expect(clears).toEqual([]);
  });

  it("does not use an unguarded clear after a bind fails", async () => {
    const failure = new Error("native bind failed");
    const stable = harness({
      bindProvider: async () => {
        throw failure;
      },
    });
    expect(
      await stable.controller.apply(
        await stable.controller.admit(signal()),
        signal(),
      ),
    ).toEqual({
      binding: "unknown",
      failure: { kind: "bind-failed", cause: failure },
    });
    expect(stable.calls.filter((call) => call.startsWith("clear"))).toEqual([]);

    const changed = harness({
      bindProvider: async () => {
        changed.state.credential = { credentialId: "cred-b" };
        throw failure;
      },
    });
    await expect(
      changed.controller.apply(
        await changed.controller.admit(signal()),
        signal(),
      ),
    ).rejects.toMatchObject({ code: "account-changed" });
    expect(changed.calls.filter((call) => call.startsWith("clear"))).toEqual(
      [],
    );
  });

  for (const replacement of [false, true]) {
    it(`uses an atomic binding guard when cleanup ${replacement ? "races with replacement" : "still owns the binding"}`, async () => {
      const failure = new Error("post-bind read failed");
      let bound = false,
        failedRead = false,
        provider = "binding-a";
      const guards: string[] = [];
      const { controller, calls } = harness({
        readCredential: async () => {
          if (bound && !failedRead) {
            failedRead = true;
            throw failure;
          }
          return { credentialId: "cred-a" };
        },
        bindProvider: async () => {
          bound = true;
          return "binding-a";
        },
        clearProviderIfCurrent: async (guard) => {
          guards.push(guard);
          // A new native binding can commit after the last JS credential read.
          // Even the same credential must retain its newer generation (ABA).
          if (replacement) provider = "binding-b";
          if (provider !== guard) return "changed";
          provider = "";
          return "cleared";
        },
      });
      const result = await controller.apply(
        await controller.admit(signal()),
        signal(),
      );
      expect(result.binding).toBe(replacement ? "unknown" : "unbound");
      expect(provider).toBe(replacement ? "binding-b" : "");
      expect(guards).toEqual(["binding-a"]);
      expect(calls.filter((call) => call.startsWith("clear"))).toEqual([]);
    });
  }

  it("keeps successful legacy hosts compatible but cannot clean without guarded support", async () => {
    const success = harness();
    expect(
      (
        await success.controller.apply(
          await success.controller.admit(signal()),
          signal(),
        )
      ).binding,
    ).toBe("cloud");
    let bound = false,
      failed = false;
    const old = harness({
      bindProvider: async () => {
        bound = true;
        return "binding-a";
      },
      readCredential: async () => {
        if (bound && !failed) {
          failed = true;
          throw Error("post-bind failure");
        }
        return { credentialId: "cred-a" };
      },
    });
    expect(
      (
        await old.controller.apply(
          await old.controller.admit(signal()),
          signal(),
        )
      ).binding,
    ).toBe("unknown");
    expect(old.calls.filter((call) => call.startsWith("clear"))).toEqual([]);
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
    const runs: string[] = [];
    const rebind = (name: string) => () => {
      runs.push(name);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = controller.requestRebind(rebind("first"));
    const second = controller.requestRebind(rebind("second"));
    const third = controller.requestRebind(rebind("latest"));
    // Coalesced callers share the queued run, which uses the latest caller's closures.
    expect(second).toBe(third);
    expect(runs).toEqual(["first"]);
    expect(controller.rebindPending).toBe(true);
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runs).toEqual(["first", "latest"]);
    let settled = false;
    void third.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await third;
    expect(controller.rebindPending).toBe(false);
  });

  it("defers a rebind while the host is busy and settles it when the host resumes", async () => {
    const { controller } = harness();
    let busy = true;
    let runs = 0;
    const rebind = async () => {
      runs++;
    };
    const deferred = controller.requestRebind(rebind, () => busy);
    expect(runs).toBe(0);
    expect(controller.resumeQueued(rebind, () => busy)).toBeUndefined();
    busy = false;
    await controller.resumeQueued(rebind, () => busy);
    await deferred;
    expect(runs).toBe(1);
    expect(controller.resumeQueued(rebind)).toBeUndefined();
  });

  it("reports a queued rebind's failure to the callers it serves, never as success", async () => {
    const queue = new ResidentRebindQueue();
    let release: () => void = () => {};
    const first = queue.request(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const queued = queue.request(async () => {
      throw new Error("bind stop unconfirmed");
    });
    release();
    await first;
    await expect(queued).rejects.toThrow("bind stop unconfirmed");
    expect(queue.active).toBe(false);
    expect(queue.pending).toBe(false);
  });

  it("reports a failed rebind to its own caller and still runs the one queued behind it", async () => {
    const queue = new ResidentRebindQueue();
    let fail: (error: Error) => void = () => {};
    let runs = 0;
    const failing = queue.request(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const queued = queue.request(async () => {
      runs++;
    });
    fail(new Error("start failed"));
    await expect(failing).rejects.toThrow("start failed");
    await queued;
    expect(runs).toBe(1);
    expect(queue.resume(async () => {})).toBeUndefined();
  });

  it("keeps a flag-only request for the host's resume, with a request interrupting the busy predicate", async () => {
    const queue = new ResidentRebindQueue();
    const runs: string[] = [];
    let replying = true;
    queue.queue();
    expect(queue.pending).toBe(true);
    // An interrupting request runs now despite the reply in flight, and serves the flag.
    await queue.request(async () => {
      runs.push("interrupting");
    });
    expect(queue.pending).toBe(false);
    queue.queue();
    expect(
      queue.resume(
        async () => {
          runs.push("resumed");
        },
        () => replying,
      ),
    ).toBeUndefined();
    replying = false;
    await queue.resume(async () => {
      runs.push("resumed");
    });
    expect(runs).toEqual(["interrupting", "resumed"]);
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
