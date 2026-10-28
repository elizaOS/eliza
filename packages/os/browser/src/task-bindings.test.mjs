import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { COMMIT_GRANT_MAX_MS, createTaskBindings } from "./task-bindings.mjs";

const origin = "https://bank.example";
const context = {
  actorId: "actor",
  accountId: "account",
  agentId: "agent",
  taskId: "task",
  epoch: 3,
};
const targetRef = "00000000-0000-4000-8000-000000000001:0:7";

async function fixture(records = new Map(), scope = {}) {
  let clock = Date.now();
  const authority = createTaskBindings({
    bindings: new Map(),
    read: async (key) => records.get(key),
    write: async (key, value) => {
      records.set(key, structuredClone(value));
    },
    clearGuidance: async () => {},
    getUrl: async () => scope.page ?? `${origin}/pay`,
    validTabId: (id) => id === "1",
    now: () => clock,
  });
  await authority.bind(
    {
      type: "task-bind",
      id: "bind",
      binding: {
        ...context,
        tabId: "1",
        bindingRevision: 1,
        origin,
        ...(scope.origins ? { origins: scope.origins } : {}),
        expiresAt: clock + 300000,
        revoked: false,
        targets: [
          { selector: "#pay", action: "click" },
          { selector: "#amount", action: "fill" },
          { selector: "#plan", action: "select" },
        ],
      },
    },
    () => true,
  );
  const grant = (overrides = {}) => ({
    grantId: "grant-1",
    taskId: context.taskId,
    epoch: context.epoch,
    origin,
    targetRef,
    selector: "#pay",
    subaction: "click",
    expiresAt: clock + 30000,
    ...overrides,
  });
  const command = (overrides = {}) => ({
    subaction: "click",
    id: "1",
    selector: targetRef,
    taskContext: context,
    expectedSelector: "#pay",
    ...overrides,
  });
  return {
    authority,
    records,
    grant,
    command,
    advance: (ms) => {
      clock += ms;
    },
  };
}

const refused = (promise) =>
  assert.rejects(promise, (error) => error.kind === "POLICY_BLOCKED");

test("a matching commit grant reaches the page once and is recorded as spent", async () => {
  const f = await fixture();
  const scoped = await f.authority.scope(f.command({ commitGrant: f.grant() }));
  assert.deepEqual(scoped.command.taskPolicy.commitGrant, {
    grantId: "grant-1",
    selector: "#pay",
    expiresAt: f.grant().expiresAt,
  });
  // The raw grant never reaches the page outside the checked task policy.
  assert.equal(scoped.command.commitGrant, undefined);
  assert.equal(f.records.get("commit-grant:grant-1").targetRef, targetRef);
  await refused(f.authority.scope(f.command({ commitGrant: f.grant() })));
  // A restarted bridge reads the spent record from storage.
  const restarted = await fixture(
    new Map([...f.records].filter(([key]) => key.startsWith("commit-grant:"))),
  );
  await refused(
    restarted.authority.scope(
      restarted.command({ commitGrant: restarted.grant() }),
    ),
  );
  // Without a grant the command is scoped as before, with no grant.
  const plain = await f.authority.scope(f.command());
  assert.equal(plain.command.taskPolicy.commitGrant, undefined);
});

test("a commit grant outside its exact task, origin, control or time is refused", async () => {
  const f = await fixture();
  const cases = [
    { taskId: "other-task" },
    { epoch: 2 },
    { origin: "https://evil.example" },
    { targetRef: "00000000-0000-4000-8000-000000000001:0:8" },
    { selector: "#amount" },
    { subaction: "fill" },
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + COMMIT_GRANT_MAX_MS + 5000 },
    { grantId: "bad id" },
    { extra: true },
    { valueHash: "0".repeat(64) },
  ];
  for (const [index, overrides] of cases.entries())
    await refused(
      f.authority.scope(
        f.command({
          commitGrant: f.grant({ grantId: `grant-${index}`, ...overrides }),
        }),
      ),
    );
  // A grant needs the reviewed control and a commit-capable subaction.
  await refused(
    f.authority.scope(
      f.command({ expectedSelector: undefined, commitGrant: f.grant() }),
    ),
  );
  await refused(
    f.authority.scope(
      f.command({
        subaction: "scroll",
        direction: "down",
        commitGrant: f.grant({ subaction: "scroll" }),
      }),
    ),
  );
  await refused(
    f.authority.scope({
      ...f.command({ commitGrant: f.grant() }),
      taskContext: undefined,
    }),
  );
  // Refused grants were not spent; the valid one still works.
  assert.ok(
    (await f.authority.scope(f.command({ commitGrant: f.grant() }))).command
      .taskPolicy.commitGrant,
  );
});

test("a value-bound grant commits only the exact approved text", async () => {
  const f = await fixture();
  const valueHash = createHash("sha256").update("120.00").digest("hex");
  const fill = (text, grantId) =>
    f.command({
      subaction: "fill",
      text,
      expectedSelector: "#amount",
      commitGrant: f.grant({
        grantId,
        subaction: "fill",
        selector: "#amount",
        valueHash,
      }),
    });
  await refused(f.authority.scope(fill("1200.00", "value-1")));
  // A fill or select grant without a value hash would commit any text.
  const unhashed = fill("120.00", "value-3");
  delete unhashed.commitGrant.valueHash;
  await refused(f.authority.scope(unhashed));
  const select = (grantId, hash) =>
    f.command({
      subaction: "select",
      text: "120.00",
      expectedSelector: "#plan",
      commitGrant: f.grant({
        grantId,
        subaction: "select",
        selector: "#plan",
        ...(hash ? { valueHash } : {}),
      }),
    });
  await refused(f.authority.scope(select("value-4", false)));
  assert.ok(
    (await f.authority.scope(select("value-5", true))).command.taskPolicy
      .commitGrant,
  );
  const scoped = await f.authority.scope(fill("120.00", "value-2"));
  assert.equal(scoped.command.taskPolicy.commitGrant.grantId, "value-2");
});

test("a grant that expires while it is being spent is refused", async () => {
  const f = await fixture();
  const grant = f.grant({ expiresAt: Date.now() + 10 });
  f.advance(20);
  await refused(f.authority.scope(f.command({ commitGrant: grant })));
});

test("an extended task's grant commits only on the origin it names", async () => {
  const signIn = "https://login.bank.example";
  const f = await fixture(new Map(), {
    origins: [origin, signIn],
    page: `${signIn}/confirm`,
  });
  // A grant for the starting origin never commits on the sign-in page.
  await refused(f.authority.scope(f.command({ commitGrant: f.grant() })));
  const scoped = await f.authority.scope(
    f.command({
      commitGrant: f.grant({ grantId: "grant-2", origin: signIn }),
    }),
  );
  assert.equal(scoped.command.taskPolicy.origin, signIn);
  assert.equal(scoped.command.taskPolicy.commitGrant.grantId, "grant-2");
});

test("a grant's request target and form hash are checked and reach the page", async () => {
  const f = await fixture();
  const formHash = "c".repeat(64);
  const scoped = await f.authority.scope(
    f.command({
      commitGrant: f.grant({
        requestTarget: { path: "/api/pay", method: "POST" },
        formHash,
      }),
    }),
  );
  assert.deepEqual(scoped.command.taskPolicy.commitGrant, {
    grantId: "grant-1",
    selector: "#pay",
    requestTarget: { path: "/api/pay", method: "POST" },
    formHash,
    expiresAt: f.grant().expiresAt,
  });
  // The spent record names what the grant was bound to.
  assert.deepEqual(f.records.get("commit-grant:grant-1").requestTarget, {
    path: "/api/pay",
    method: "POST",
  });
  assert.equal(f.records.get("commit-grant:grant-1").formHash, formHash);
  const url = await f.authority.scope(
    f.command({
      commitGrant: f.grant({
        grantId: "grant-url",
        requestTarget: { url: "https://api.bank.example/pay", method: "PUT" },
      }),
    }),
  );
  assert.deepEqual(url.command.taskPolicy.commitGrant.requestTarget, {
    url: "https://api.bank.example/pay",
    method: "PUT",
  });
  const malformed = [
    { requestTarget: null },
    { requestTarget: { path: "/api/pay" } },
    { requestTarget: { path: "/api/pay", method: "post" } },
    { requestTarget: { path: "api/pay", method: "POST" } },
    { requestTarget: { path: "//evil.example/pay", method: "POST" } },
    { requestTarget: { url: "http://bank.example/pay", method: "POST" } },
    { requestTarget: { url: "https://u:p@bank.example/pay", method: "POST" } },
    { requestTarget: { url: "https://bank.example/pay#x", method: "POST" } },
    {
      requestTarget: {
        url: "https://bank.example/pay",
        path: "/pay",
        method: "POST",
      },
    },
    { requestTarget: { path: "/pay", method: "POST", body: "x" } },
    { formHash: "C".repeat(64) },
    { formHash: "c".repeat(63) },
    { formHash: 1 },
  ];
  for (const [index, overrides] of malformed.entries())
    await refused(
      f.authority.scope(
        f.command({
          commitGrant: f.grant({ grantId: `bad-${index}`, ...overrides }),
        }),
      ),
    );
});
