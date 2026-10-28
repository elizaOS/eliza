import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NoticeOwnerCoordinator,
  type NoticeOwnerSnapshot,
  type PendingNoticeTap,
  resolveNoticeTap,
  revalidateWorkflowApprovalNotice,
  type WorkflowNoticeRoute,
  workflowApprovalNoticeIdentity,
} from "./notice-routes.ts";

const A: NoticeOwnerSnapshot = {
  identity: "session-a",
  owner: { origin: "https://a.invalid", ownerId: "a", agentId: "agent" },
  hasSession: true,
};
const signedOut: NoticeOwnerSnapshot = {
  identity: "",
  owner: null,
  hasSession: false,
};

function coordinator() {
  let available = true;
  let fail = false;
  let restore: (valid: () => boolean) => Promise<void> = async () => {};
  let queue = Promise.resolve();
  const transitions: string[] = [];
  const restores: string[] = [];
  const c = new NoticeOwnerCoordinator<object>({
    transition: async (s) => {
      transitions.push(s.owner?.ownerId ?? "");
      if (fail) throw new Error("disk");
      return {};
    },
    enqueue: (work) => {
      queue = queue.then(work);
    },
    available: () => available,
    restore: async (_result, s, valid) => {
      restores.push(s.owner?.ownerId ?? "");
      await restore(valid);
    },
  });
  return {
    c,
    transitions,
    restores,
    drain: () => queue,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setFail: (value: boolean) => {
      fail = value;
    },
    setRestore: (value: (valid: () => boolean) => Promise<void>) => {
      restore = value;
    },
  };
}

test("the owner fence retries a revalidation the host could not finish", async () => {
  const f = coordinator();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setRestore(async (valid) => {
    await held;
    assert.equal(valid(), false);
  });
  f.c.update(A);
  await new Promise((resolve) => setImmediate(resolve));
  f.setAvailable(false);
  release();
  await f.drain();
  f.setAvailable(true);
  f.setRestore(async () => {});
  f.c.update(A);
  await f.drain();
  assert.deepEqual(f.transitions, ["a", "a"]);
  assert.equal(f.restores.length, 2);
});

test("a failed fence never hides the later sign-out", async () => {
  const f = coordinator();
  f.c.update(signedOut);
  await f.drain();
  assert.deepEqual(f.transitions, [], "startup without a session waits");
  f.setFail(true);
  f.c.update(A);
  await f.drain();
  f.setFail(false);
  f.c.update(signedOut);
  await f.drain();
  assert.deepEqual(f.transitions, ["a", ""]);
});

test("a busy reconnect publishes no null owner; a settled sign-out still fences", async () => {
  const f = coordinator();
  f.c.update(A);
  await f.drain();
  f.c.update({ ...signedOut, busy: true });
  await f.drain();
  f.c.update({ ...A, identity: "session-a2" });
  await f.drain();
  assert.deepEqual(f.transitions, ["a", "a"]);
  f.c.update({ ...signedOut, busy: true });
  await f.drain();
  f.c.update(signedOut);
  await f.drain();
  assert.deepEqual(f.transitions, ["a", "a", ""]);
});

test("startup resolved without a session fences in no owner", async () => {
  const f = coordinator();
  f.c.update({ ...signedOut, startupResolved: true });
  await f.drain();
  assert.deepEqual(f.transitions, [""]);
  assert.deepEqual(f.restores, [], "nothing is revalidated without a session");
});

const route: WorkflowNoticeRoute = {
  scope: "a".repeat(64),
  origin: "https://agent.invalid",
  ownerId: "owner",
  agentId: "agent",
  workflowId: "flow",
  runId: "run",
  versionId: "v1",
};
const identifiers = ["workflowId", "runId", "versionId"] as const;

function tapFixture() {
  const tap: PendingNoticeTap = {
    ...route,
    token: "tap",
    operationId: "operation",
    bindingHash: "b".repeat(64),
    retained: true,
  };
  let reads = 0;
  let pending: () => Promise<Partial<PendingNoticeTap>> = async () => tap;
  let loaded: (t: PendingNoticeTap) => { run: string } | null = () => ({
    run: "run",
  });
  let current = true;
  const resolve = (signal = new AbortController().signal) =>
    resolveNoticeTap({
      pending: () => pending(),
      binding: { ...route, current: () => current },
      identifiers,
      load: async (t, _signal, checkpoint) => {
        reads++;
        checkpoint();
        return loaded(t);
      },
      signal,
    });
  return {
    tap,
    resolve,
    reads: () => reads,
    setPending: (value: () => Promise<Partial<PendingNoticeTap>>) => {
      pending = value;
    },
    setLoaded: (value: (t: PendingNoticeTap) => { run: string } | null) => {
      loaded = value;
    },
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

test("a tap opens only through its exact route, read again before it is exposed", async () => {
  const f = tapFixture();
  f.setPending(async () => {
    throw new Error("Activity inactive");
  });
  assert.deepEqual(await f.resolve(), { kind: "lookup-unavailable" });
  assert.equal(f.reads(), 0, "an unavailable lookup reads nothing");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => f.resolve(aborted.signal), { name: "AbortError" });
  f.setPending(async () => f.tap);
  assert.deepEqual(await f.resolve(), {
    kind: "ready",
    token: "tap",
    target: { run: "run" },
    question: false,
  });
  f.setPending(async () => ({}));
  assert.deepEqual(await f.resolve(), { kind: "none" });
  f.setPending(async () => ({ ...f.tap, ownerId: "other" }));
  assert.deepEqual(await f.resolve(), { kind: "other-account" });
  f.setPending(async () => ({ ...f.tap, retained: false }));
  assert.deepEqual(await f.resolve(), { kind: "unavailable" });
  f.setPending(async () => ({ ...f.tap, runId: undefined }));
  assert.deepEqual(await f.resolve(), { kind: "unavailable" });
  f.setPending(async () => f.tap);
  f.setLoaded(() => null);
  assert.deepEqual(await f.resolve(), { kind: "unavailable" });
});

test("a tap that changed, lost its receipt or its agent during the reads is not opened", async () => {
  for (const change of [
    { versionId: "v2" },
    { retained: false },
    { question: true },
    { token: "other" },
  ]) {
    const f = tapFixture();
    let reads = 0;
    f.setPending(async () => (++reads === 2 ? { ...f.tap, ...change } : f.tap));
    assert.deepEqual(
      await f.resolve(),
      { kind: "unavailable" },
      JSON.stringify(change),
    );
  }
  const offline = tapFixture();
  let checks = 0;
  offline.setPending(async () => {
    if (++checks === 2) throw new Error("Queue recheck unavailable");
    return offline.tap;
  });
  await assert.rejects(() => offline.resolve(), /Queue recheck unavailable/);
  const switched = tapFixture();
  switched.setLoaded(() => {
    switched.setCurrent(false);
    return { run: "run" };
  });
  await assert.rejects(() => switched.resolve(), /Agent changed/);
});

test("approval notice identities keep their installed derivation", async () => {
  const one = await workflowApprovalNoticeIdentity(
    { ...route, runId: "run-1" },
    "proposal-1",
  );
  // Golden values: the identities already posted on phones by the original host derivation.
  assert.deepEqual(one, {
    id: "approval-8537c598d08c3668086ff971fc9a0831ccce25749bbdca6a68c5f80a8bfab8bc",
    bindingHash:
      "94ec75c864dfafa9ccf60d30b586668f21d2b84b8044de7363041355358c58ab",
  });
  const otherVersion = await workflowApprovalNoticeIdentity(
    { ...route, runId: "run-1", versionId: "v2" },
    "proposal-1",
  );
  assert.equal(otherVersion.id, one.id, "one notice per approval");
  assert.equal(
    otherVersion.bindingHash,
    "5aea0cac562ce4aa6f93e79e9fe146e92aaa8663ea73c3152a80643644b14b6e",
  );
  await assert.rejects(
    () => workflowApprovalNoticeIdentity(route, ""),
    /Invalid approval notice identity/,
  );
  await assert.rejects(
    () => workflowApprovalNoticeIdentity(route, "x".repeat(257)),
    /Invalid approval notice identity/,
  );
});

test("a returning owner's approval notice is reposted only while it is exactly pending", async () => {
  const bound = await workflowApprovalNoticeIdentity(route, "proposal");
  const notice = { ...bound, route, expiresAt: 200 };
  type Reads = Parameters<
    typeof revalidateWorkflowApprovalNotice<object, object>
  >[1];
  function fixture() {
    let live = true;
    const reads: Reads = {
      detail: async () => ({ versionId: "v1" }),
      receipt: async () => ({ versionId: "v1", finished: false }),
      phoneReview: async () => ({
        finished: false,
        cancellationRequestedAt: null,
      }),
      pending: async () => [{ id: "proposal", expiresAt: 200 }],
    };
    return { reads, valid: () => live, stop: () => (live = false) };
  }
  const run = (f: ReturnType<typeof fixture>, n = notice) =>
    revalidateWorkflowApprovalNotice(
      n,
      f.reads,
      f.valid,
      new AbortController().signal,
      () => 100,
    );
  assert.equal(await run(fixture()), "resume");
  const changes: Array<(reads: Reads) => void> = [
    (r) => (r.detail = async () => ({ versionId: "v2" })),
    (r) => (r.detail = async () => ({ versionId: "v1", removed: true })),
    (r) => (r.receipt = async () => ({ versionId: "v2", finished: false })),
    (r) => (r.receipt = async () => ({ versionId: "v1", finished: true })),
    (r) =>
      (r.phoneReview = async () => ({
        finished: false,
        cancellationRequestedAt: "now",
      })),
    (r) => (r.pending = async () => []),
    (r) => (r.pending = async () => [{ id: "different", expiresAt: 200 }]),
    (r) => (r.pending = async () => [{ id: "proposal", expiresAt: 201 }]),
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.reads);
    assert.equal(await run(f), "withdraw");
  }
  assert.equal(await run(fixture(), { ...notice, expiresAt: 99 }), "withdraw");
  assert.equal(
    await run(fixture(), { ...notice, bindingHash: "b".repeat(64) }),
    "withdraw",
  );
  const stale = fixture();
  stale.reads.detail = async () => {
    stale.stop();
    return { versionId: "v1" };
  };
  assert.equal(await run(stale), "stale");
  const offline = fixture();
  offline.reads.detail = async () => {
    throw new Error("offline");
  };
  await assert.rejects(() => run(offline), /offline/);
});
