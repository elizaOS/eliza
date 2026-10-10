import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTaskGateway as createGateway } from "@elizaos/host/native-host";
import { createLocalAgentGateway as createHttpGateway } from "../../../packages/agent/native-host/gateway.mjs";
import { buildTaskRuntime as build } from "../../../packages/app/scripts/build-consumer-task-runtime.mjs";
import { createBillOutcomeStore } from "./bill-outcome-store.mjs";
import { createBillSourceStore } from "./bill-source-store.mjs";
import { createBillTaskRoutes } from "./bill-task-routes.mjs";

const sourceRoot = resolve(import.meta.dirname, "../../..");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: sourceRoot,
  encoding: "utf8",
}).trim();
const buildTaskRuntime = (output) =>
  build(output, { sourceRoot, sourceCommit });
const copy = {
  existingMethodPrompt: "Use this method?",
  existingMethodLabel: "Use method",
  pendingChoiceMessage: "Choice pending",
  staleChoiceMessage: "Review changed",
};
function createTaskGateway({
  workflowFactory,
  discoverBills,
  requiresBillSelection,
  ...options
}) {
  return createGateway({
    ...options,
    agentId: "fixture-bill-agent",
    connectorSource: "fixture-bill-host",
    extensionFactory: (context) =>
      createBillTaskRoutes({
        ...context,
        workflowFactory,
        discoverBills,
        requiresBillSelection,
        copy,
        outcomeStore: createBillOutcomeStore(context.db, context.store),
        sourceStore: createBillSourceStore(context.db, context.store),
      }),
  });
}
const createLocalAgentGateway = (options) =>
  createHttpGateway({
    ...options,
    hostPolicy: {
      origins: [],
      prepareMessage: () => {
        throw new Error("Fixture does not admit chat");
      },
      validateTitle: () => false,
      isPaidAction: () => false,
      formatTaskContext: () => "",
      resetPaths: [],
    },
  });
test("duplicate HTTP choice delivery does not re-observe or execute the pending choice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-choice-http-"));
  const bundlePath = join(directory, "runtime.mjs");
  buildTaskRuntime(bundlePath);
  let reads = 0,
    effects = 0,
    selected = false,
    release,
    enter;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const key = "a".repeat(64),
    credentialGate = async () => "account";
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate,
    actuator: { capabilities: ["fill"] },
    authorizeGoal: async (goalRef) => ({
      id: "choice-task",
      goalRef,
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["fill"],
      allowedOrigins: ["https://example.test"],
    }),
    // Controlled workflow isolates the transport/commit race; no real browser or payment.
    workflowFactory: () => ({
      refresh: async () => {
        reads++;
        return {
          kind: selected ? "human-submit" : "choose-existing-method",
          reviewKey: key,
        };
      },
      chooseExistingMethod: async (received, { isCurrent }) => {
        assert.equal(received, key);
        assert.equal(isCurrent(), true);
        effects++;
        enter();
        await waiting;
        selected = true;
        return { kind: "human-submit", reviewKey: key };
      },
    }),
  });
  const server = createLocalAgentGateway({
    token: "upstream",
    inboundToken: "native-secret",
    credentialGate,
    taskGateway: gateway,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, body) =>
    fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer native-secret",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await call("/tasks", { goalRef: "bill" })).status, 201);
    const offered = (await (await call("/tasks/choice-task/bill")).json())
      .decision.choice;
    const body = {
      callbackData: offered.callbackData,
      contextKey: offered.contextKey,
      value: "existing",
    };
    const first = call("/tasks/choice-task/bill", body);
    await started;
    const duplicate = await call("/tasks/choice-task/bill", body);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).decision.kind, "choice-pending");
    assert.equal(reads, 1);
    assert.equal(effects, 1);
    release();
    assert.equal((await (await first).json()).decision.kind, "human-submit");
    assert.equal(
      (await (await call("/tasks/choice-task/bill", body)).json()).decision
        .kind,
      "human-submit",
    );
    assert.equal(effects, 1);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bill workflow authorization accepts the current request and rejects it after logout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-bill-authorization-"));
  const bundlePath = join(directory, "runtime.mjs");
  buildTaskRuntime(bundlePath);
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "account-a",
    actuator: { capabilities: ["fill"] },
    workflowFactory: ({ stillAuthorized }) => ({
      refresh: async () => {
        const authorized = await stillAuthorized();
        entered(authorized);
        await waiting;
        assert.equal(await stillAuthorized(), false);
        return { kind: "human-sign-in" };
      },
    }),
  });
  try {
    const runtime = await gateway.forCurrentOwner();
    runtime.create({
      id: "bill-auth",
      goalRef: "controlled",
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: ["fill"],
      allowedOrigins: ["https://example.org"],
    });
    const pending = gateway.handle(
      new Request("http://localhost/tasks/bill-auth/bill"),
    );
    const authorized = await started;
    await gateway.revoke();
    release();
    assert.equal((await pending).status, 401);
    assert.equal(authorized, true);
  } finally {
    release();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source selection gates the workflow, rereads before committing and reuses the durable choice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-selection-gateway-")),
    bundlePath = join(directory, "runtime.mjs");
  buildTaskRuntime(bundlePath);
  const candidate = {
    billId: "a".repeat(64),
    candidateId: "b".repeat(64),
    sourceRef: `bill-source:${"a".repeat(64)}`,
    facts: {
      company: "Test",
      origin: "https://example.org",
      accountLabel: "Ending 1234",
      amountMinor: 12345,
      currency: "USD",
      currencyDigits: 2,
      dueDate: "2026-10-01",
    },
    sources: [
      {
        kind: "gmail-message",
        messageId: "m1",
        accountRef: "c".repeat(64),
        contentSha256: "d".repeat(64),
      },
    ],
  };
  let reads = 0,
    workflows = 0,
    failure = null;
  const gateway = await createTaskGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "owner",
    actuator: { capabilities: [] },
    requiresBillSelection: true,
    authorizeGoal: async (goalRef) => ({
      id: "source-task",
      goalRef,
      authorization: {
        decisionId: "grant",
        policyRevision: "policy",
        state: "active",
        decidedAt: new Date().toISOString(),
        revokedAt: null,
      },
      allowedCapabilities: [],
      allowedOrigins: ["https://example.org"],
    }),
    discoverBills: async () => {
      if (failure) throw failure;
      reads++;
      return { status: "candidate", candidates: [candidate] };
    },
    workflowFactory: ({ sourceSelection }) => {
      workflows++;
      assert.equal(sourceSelection.candidate.facts.amountMinor, 12345);
      return { refresh: async () => ({ kind: "human-sign-in" }) };
    },
  });
  const req = (path, body) =>
    gateway.handle(
      new Request(`http://localhost${path}`, {
        method: body ? "POST" : "GET",
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      }),
    );
  try {
    assert.equal((await req("/tasks", { goalRef: "bill" })).status, 201);
    assert.equal(
      (await (await req("/tasks/source-task/bill")).json()).decision.kind,
      "source-selection-required",
    );
    assert.equal(workflows, 0);
    // A failed search names only a fixed reason, never provider text.
    for (const [reason, expected] of [
      ["reauth_required", "reauth_required"],
      ["cloud_sign_in_required", "cloud_sign_in_required"],
      ["account_changed", "account_changed"],
      ["private provider text", "unavailable"],
    ]) {
      failure = Object.assign(new Error("private provider text"), {
        code: "BILL_SOURCES_UNAVAILABLE",
        reason,
      });
      const failed = await req("/tasks/source-task/source-bills");
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), {
        code: "BILL_DISCOVERY_UNAVAILABLE",
        reason: expected,
      });
    }
    failure = null;
    const offer = await (await req("/tasks/source-task/source-bills")).json();
    const input = {
      offerId: offer.offerId,
      candidateId: candidate.candidateId,
      expectedRevision: offer.expectedRevision,
    };
    const selected = await (
      await req("/tasks/source-task/source-bills", input)
    ).json();
    assert.equal(selected.status, "selected");
    assert.equal(reads, 2);
    assert.deepEqual(
      await (await req("/tasks/source-task/source-bills", input)).json(),
      selected,
    );
    assert.equal(reads, 2);
    const decision = (await (await req("/tasks/source-task/bill")).json())
      .decision;
    assert.equal(decision.kind, "human-sign-in");
    assert.deepEqual(decision.billSources, candidate.sources);
    assert.equal(workflows, 1);
    assert.equal(
      (
        await req("/tasks/source-task/source-bills", {
          ...input,
          candidateId: "e".repeat(64),
        })
      ).status,
      409,
    );
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
async function routeFixture(t, workflowFactory) {
  const directory = await mkdtemp(join(tmpdir(), "bill-route-evidence-"));
  const bundlePath = join(directory, "runtime.mjs");
  buildTaskRuntime(bundlePath);
  let route, stores;
  const gateway = await createGateway({
    bundlePath,
    databasePath: join(directory, "journal.sqlite"),
    credentialGate: async () => "owner",
    actuator: { capabilities: [] },
    extensionFactory: (context) => {
      stores = {
        ...context,
        outcomeStore: createBillOutcomeStore(context.db, context.store),
        sourceStore: createBillSourceStore(context.db, context.store),
      };
      route = createBillTaskRoutes({ ...stores, copy, workflowFactory });
      return route;
    },
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  const runtime = await gateway.forCurrentOwner();
  const task = runtime.create({
    id: "bill",
    goalRef: "bill",
    authorization: {
      decisionId: "grant",
      policyRevision: "policy",
      state: "active",
      decidedAt: new Date().toISOString(),
      revokedAt: null,
    },
    allowedCapabilities: [],
    allowedOrigins: ["https://example.test"],
  });
  return {
    route,
    stores,
    runtime,
    task,
    context: {
      owner: runtime.owner,
      runtime,
      requestEpoch: 0,
      currentEpoch: () => 0,
      authenticate: async () => runtime.owner,
    },
  };
}

test("route suppresses a completed workflow response after actor, epoch or cancellation changes", async (t) => {
  for (const change of ["actor", "epoch", "abort"])
    await t.test(change, async (t) => {
      const controller = new AbortController();
      let epoch = 0;
      const f = await routeFixture(t, () => ({
        refresh: async () => ({ kind: "human-sign-in" }),
      }));
      f.context.currentEpoch = () => epoch;
      f.context.authenticate = async () => {
        if (change === "epoch") epoch++;
        if (change === "abort") controller.abort();
        return change === "actor"
          ? { ...f.runtime.owner, actorId: "different" }
          : f.runtime.owner;
      };
      const response = await f.route(
        new Request("http://localhost/tasks/bill/bill", {
          signal: controller.signal,
        }),
        f.context,
      );
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { code: "TASK_UNAUTHORIZED" });
    });
});

test("malformed bill POST JSON is a client error with no workflow effect", async (t) => {
  let effects = 0;
  const f = await routeFixture(t, () => ({
    refresh: async () => {
      effects++;
      return { kind: "human-sign-in" };
    },
    chooseExistingMethod: async () => {
      effects++;
      return { kind: "human-sign-in" };
    },
  }));
  const response = await f.route(
    new Request("http://localhost/tasks/bill/bill", {
      method: "POST",
      body: '{"callbackData":',
    }),
    f.context,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: "TASK_INVALID" });
  assert.equal(effects, 0);
});

test("repeat choice POST restores the stored outcome without another workflow effect", async (t) => {
  let refreshes = 0,
    choices = 0;
  const f = await routeFixture(t, () => ({
    refresh: async () => {
      refreshes++;
      return { kind: "human-sign-in" };
    },
    chooseExistingMethod: async () => {
      choices++;
      return { kind: "human-sign-in" };
    },
  }));
  const observedAt = Date.now();
  f.stores.store.transition(
    f.task.id,
    {
      owner: f.runtime.owner,
      expectedRevision: f.task.revision,
      now: observedAt,
    },
    {
      type: "observe",
      observation: {
        id: "receipt",
        pageId: "page",
        origin: "https://example.test",
        version: 1,
        inputRevision: 0,
        observedAt,
      },
    },
  );
  const saved = f.stores.outcomeStore.forTask(f.runtime, f.task.id).save(
    {
      kind: "outcome",
      status: "paid",
      reference: "FIXTURE-RECEIPT",
      source: "https://example.test/receipt",
      billSource: "mail:fixture",
      totalMinor: 1200,
      paymentDate: "2026-10-01",
      currency: "USD",
      currencyDigits: 2,
    },
    "receipt",
  );
  assert.equal(saved.saveStatus, "saved");
  const response = await f.route(
    new Request("http://localhost/tasks/bill/bill", {
      method: "POST",
      body: JSON.stringify({
        callbackData: `is1:${"a".repeat(32)}`,
        contextKey: "b".repeat(64),
        value: "existing",
      }),
    }),
    f.context,
  );
  assert.equal(response.status, 200);
  const result = (await response.json()).decision;
  assert.equal(result.reference, "FIXTURE-RECEIPT");
  assert.equal(result.saveStatus, "saved");
  assert.equal(refreshes, 0);
  assert.equal(choices, 0);
});
