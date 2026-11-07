import assert from "node:assert/strict";
import test from "node:test";
import {
  controls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { createBillHelperHost } from "./bill-helper-host.mjs";
import { BillWorkflow } from "./bill-workflow.mjs";

test("host rechecks task and account after asynchronous connector resolution", async () => {
  let resolverOptions,
    revocations = 0,
    account = "owner";
  class Actuator {
    constructor(options) {
      this.options = options;
    }
    async quiesce() {}
  }
  class Resolver {
    constructor(options) {
      resolverOptions = options;
    }
    revoke() {
      revocations++;
    }
  }
  const owner = {
    actorId: "owner",
    agentId: "agent",
    connector: { source: "app", accountId: "owner" },
  };
  const task = {
    id: "task",
    owner,
    epoch: 1,
    status: "active",
    authorization: { state: "active" },
    allowedOrigins: ["https://provider.example"],
  };
  const runtime = { owner, get: () => structuredClone(task) };
  let delayed = false;
  const host = createBillHelperHost({
    deriveBillDecision,
    controls,
    runtimeModule: {
      NativeTaskActuator: Actuator,
      GoogleTaskCodeResolver: Resolver,
    },
    target: { bindTask() {}, execute() {}, guideTask() {} },
    credentialGate: async () => account,
    authorizeGoal: async () => ({}),
    billForTask: () => ({}),
    policyForTask: () => ({}),
    verify: async () => {},
    recordEvidence: async () => {},
    google: {
      service: {},
      parse: () => null,
      challengeForBill: async () => null,
      accountForTask: async () => {
        if (delayed) task.epoch++;
        return "google";
      },
    },
  });
  assert.equal(host.reconcileTask, undefined);
  const actuator = host.actuatorFactory({ owner, getTask: () => task });
  host.workflowFactory({ runtime, task });
  const context = {
    taskId: "task",
    actorId: "owner",
    agentId: "agent",
    accountId: "google",
    epoch: 1,
    providerOrigin: "https://provider.example",
  };
  assert.equal(await resolverOptions.authorize(context), true);
  delayed = true;
  assert.equal(await resolverOptions.authorize(context), false);
  delayed = false;
  context.epoch = task.epoch;
  account = "other";
  assert.equal(await resolverOptions.authorize(context), false);
  await assert.rejects(host.authorizeGoal("bill", owner));
  account = "owner";
  task.status = "paused";
  await actuator.quiesce({ taskId: "task" });
  assert.equal(revocations, 1);
  host.close();
  assert.equal(await resolverOptions.authorize(context), false);
});

test("bill discovery is bound to current task epoch and Google account scope", async () => {
  const { parseControlledBillMessage } = await import(
    "../test/fixtures/bill-host/policy.mjs"
  );
  class Actuator {
    async quiesce() {}
  }
  const owner = {
    actorId: "owner",
    agentId: "agent",
    connector: { source: "app", accountId: "owner" },
  };
  const task = {
    id: "task",
    owner,
    epoch: 1,
    status: "active",
    authorization: { state: "active" },
    allowedOrigins: ["https://provider.example"],
  };
  const runtime = { owner, get: () => structuredClone(task) };
  let change = false,
    reads = 0;
  const message = {
    externalId: "m1",
    fromEmail: "bills@example.org",
    to: ["person@example.org"],
    receivedAt: "2026-09-10T00:00:00Z",
  };
  const host = createBillHelperHost({
    deriveBillDecision,
    controls,
    runtimeModule: { NativeTaskActuator: Actuator },
    target: { bindTask() {}, execute() {}, guideTask() {} },
    credentialGate: async () => "owner",
    authorizeGoal: async () => ({}),
    billForTask: () => ({}),
    policyForTask: () => ({}),
    verify: async () => {},
    recordEvidence: async () => {},
    billDiscovery: {
      scopeForTask: async () => ({
        accountId: "google-account",
        billingAccountRef: "utility-account",
        company: "Test",
        accountLabel: "Ending 1234",
        recipient: "person@example.org",
        senders: ["bills@example.org"],
        searchQuery: "from:bills@example.org",
        providerOrigin: "https://provider.example",
        after: Date.parse("2026-09-01"),
        before: Date.parse("2026-10-01"),
      }),
      parse: parseControlledBillMessage,
      google: {
        searchGmailMessagesPage: async (input) => {
          assert.equal(input.accountId, "google-account");
          return { messages: [message] };
        },
        getGmailMessageDetail: async () => {
          reads++;
          if (change) task.epoch++;
          return {
            message,
            bodyText:
              "Controlled test bill\nInvoice: 1\nCompany: Test\nWebsite: https://provider.example\nAccount: Ending 1234\nAmount: USD 1.00\nDue date: 2026-09-30\n",
          };
        },
      },
    },
  });
  host.actuatorFactory({ owner, getTask: () => task });
  const args = { runtime, task, signal: new AbortController().signal };
  assert.equal((await host.discoverBills(args)).status, "candidate");
  change = true;
  await assert.rejects(host.discoverBills(args), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
  task.status = "paused";
  change = false;
  const before = reads;
  await assert.rejects(host.discoverBills(args), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
  assert.equal(reads, before);
  host.close();
  await assert.rejects(host.discoverBills(args));
});

test("readback binds one saved selection, fences account changes and clears its temporary context", async () => {
  let account = "owner",
    reads = 0,
    pending = false,
    release;
  class Actuator {
    constructor(options) {
      this.options = options;
    }
    async quiesce() {}
  }
  const owner = {
    actorId: "owner",
    agentId: "agent",
    connector: { source: "app", accountId: "owner" },
  };
  const proposal = { id: "selection", taskId: "task" };
  const task = {
    id: "task",
    owner,
    revision: 3,
    operations: [{ proposal, status: "unknown" }],
    allowedOrigins: ["https://biller.example"],
  };
  const record = { operationId: proposal.id };
  const host = createBillHelperHost({
    deriveBillDecision,
    controls,
    runtimeModule: { NativeTaskActuator: Actuator },
    target: {
      bindTask() {},
      execute() {
        throw Error("Readback must not dispatch");
      },
      guideTask() {},
    },
    credentialGate: async () => account,
    authorizeGoal: async () => ({}),
    billForTask: () => ({ sourceRef: "mail:bill" }),
    policyForTask: () => ({}),
    verify: async () => {},
    recordEvidence: async () => {},
    reconcileMethod: async (input) => {
      reads++;
      assert.deepEqual(input.record, record);
      assert.equal(input.bill.sourceRef, "mail:bill");
      if (pending)
        await new Promise((resolve) => {
          release = resolve;
        });
      return { status: "succeeded", evidenceRef: "readback" };
    },
  });
  const actuator = host.actuatorFactory({ owner, getTask: () => task });
  const runtime = {
    owner,
    reconcile: async (id, revision, operationId, isCurrent) => {
      assert.equal(id, task.id);
      assert.equal(revision, 3);
      assert.equal(operationId, proposal.id);
      assert.equal(await isCurrent(), true);
      return actuator.options.reconcile(task, proposal, {});
    },
  };
  const input = {
    runtime,
    task,
    outcomes: {
      loadMethodSelection: (id) => {
        assert.equal(id, proposal.id);
        return record;
      },
    },
    stillAuthorized: () => true,
  };
  await assert.rejects(
    actuator.options.reconcile(task, proposal, {}),
    /Unbound bill recovery/,
  );
  assert.equal((await host.reconcileTask(input)).status, "succeeded");
  assert.equal(reads, 1);
  await assert.rejects(
    actuator.options.reconcile(task, proposal, {}),
    /Unbound bill recovery/,
  );
  await assert.rejects(
    host.reconcileTask({ ...input, task: { ...task, operations: [] } }),
    /single unknown/,
  );
  await assert.rejects(
    host.reconcileTask({
      ...input,
      task: { ...task, operations: [...task.operations, ...task.operations] },
    }),
    /single unknown/,
  );
  pending = true;
  const inFlight = host.reconcileTask(input);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(host.reconcileTask(input), /recovery unavailable/);
  account = "other";
  release();
  await assert.rejects(inFlight, /account unavailable/);
  account = "owner";
  pending = false;
  assert.equal((await host.reconcileTask(input)).status, "succeeded");
  host.close();
  await assert.rejects(host.reconcileTask(input), /account unavailable/);
});

test("a host composes its own workflow, fill values and action words", async () => {
  class Actuator {
    constructor(options) {
      this.options = options;
    }
    async quiesce() {}
  }
  const owner = {
    actorId: "owner",
    agentId: "agent",
    connector: { source: "app", accountId: "owner" },
  };
  const task = {
    id: "task",
    owner,
    epoch: 1,
    status: "active",
    authorization: { state: "active" },
    allowedOrigins: ["https://provider.example"],
  };
  const runtime = { owner, get: () => structuredClone(task) };
  const base = {
    deriveBillDecision,
    controls,
    runtimeModule: { NativeTaskActuator: Actuator },
    target: { bindTask() {}, execute() {}, guideTask() {} },
    credentialGate: async () => "owner",
    authorizeGoal: async () => ({}),
    billForTask: () => ({}),
    policyForTask: () => ({}),
    verify: async () => {},
    recordEvidence: async () => {},
  };
  // The host's own look; the shared steps that look again use it too.
  class ProductWorkflow extends BillWorkflow {
    constructor(options, words) {
      super(options);
      this.words = { ...this.words, product: words };
    }
    async refresh() {
      return {
        kind: "human-review",
        reasonCode: "product-look",
        message: this.words.product,
      };
    }
  }
  const describeAction = () => "I will fill in the bill amount.";
  const host = createBillHelperHost({
    ...base,
    assistantName: "Helper",
    actuatorOptions: { describeAction, target: null },
    valueResolver: async (reference, current, resolveCode) =>
      reference === "host:amount" ? "42.00" : resolveCode(reference, current),
    createWorkflow: (options, input) =>
      new ProductWorkflow(options, input.words),
  });
  const actuator = host.actuatorFactory({ owner, getTask: () => task });
  assert.equal(actuator.options.assistantName, "Helper");
  assert.equal(actuator.options.describeAction, describeAction);
  assert.notEqual(actuator.options.target, null, "the host's target wins");
  assert.equal(
    await actuator.options.resolveValue("host:amount", task),
    "42.00",
  );
  await assert.rejects(
    actuator.options.resolveValue("code:1", task),
    /Protected code resolution unavailable/,
  );
  const workflow = host.workflowFactory({
    runtime,
    task,
    words: "Check the amount.",
  });
  assert.ok(workflow instanceof ProductWorkflow);
  assert.equal(workflow.assistantName, "Helper");
  assert.equal((await workflow.fill("no-offer")).reasonCode, "product-look");
  assert.equal(
    (await workflow.chooseExistingMethod("review")).message,
    "Check the amount.",
  );
  const other = createBillHelperHost({ ...base, createWorkflow: () => ({}) });
  other.actuatorFactory({ owner, getTask: () => task });
  assert.throws(
    () => other.workflowFactory({ runtime, task }),
    /Invalid bill workflow/,
  );
  assert.throws(
    () => createBillHelperHost({ ...base, valueResolver: "registry" }),
    /Invalid bill helper host composition/,
  );
  assert.throws(
    () => createBillHelperHost({ ...base, assistantName: "" }),
    /Invalid assistant name/,
  );
});
