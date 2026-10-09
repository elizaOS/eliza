import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  controls,
  deriveBillDecision,
} from "../test/fixtures/bill-host/policy.mjs";
import { buildTaskRuntime } from "../test/fixtures/bill-host/runtime.mjs";
import { BillCodeCoordinator } from "./bill-code-coordinator.mjs";
import { createConfiguredBillHelper } from "./configured-bill-helper.mjs";

async function fixture(
  t,
  { failStart, failHostClose, failStop, failHostCreate } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "helper-lifecycle-"));
  const endpoint = join(root, "browser.sock");
  const server = createServer((socket) =>
    socket.on("data", (data) => socket.write(data)),
  );
  server.listen(endpoint);
  await once(server, "listening");
  let socket;
  t.after(async () => {
    socket?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const events = [];
  let options;
  class Target {
    getProfileId() {
      return "profile";
    }
    async start() {
      socket = createConnection(endpoint);
      await once(socket, "connect");
      events.push("connected");
      if (failStart) throw new Error("start failed");
    }
    async stop() {
      events.push("stop");
      if (socket && !socket.destroyed) {
        const closed = once(socket, "close");
        socket.destroy();
        await closed;
      }
      if (failStop) throw new Error("stop failed");
    }
    async execute(value) {
      const reply = once(socket, "data");
      socket.write(value);
      return (await reply)[0].toString();
    }
  }
  const args = {
    configuration: { actorId: "owner", goalRef: "goal", profileId: "profile" },
    runtimeModule: { NativeSocketBrowserTarget: Target },
    credentialGate: async () => "owner",
    evidenceDirectory: join(root, "evidence"),
    validateBillControls: () => ({}),
    hostPolicy: {
      validateConfiguration: structuredClone,
      hostOptions: () => ({}),
      evidenceNamespace: "evidence",
      evidenceRecord: ({ task, status }) => ({ taskId: task.id, status }),
      describeHelper: () => ({ kind: "fixture" }),
    },
    createBillHelperHost(value) {
      if (failHostCreate) throw new Error("host construction failed");
      options = value;
      return {
        close() {
          events.push("host close");
          if (failHostClose === "sync") throw new Error("host close failed");
          if (failHostClose)
            return Promise.reject(new Error("host close rejected"));
        },
      };
    },
  };
  return {
    args,
    root,
    events,
    get options() {
      return options;
    },
    get disconnected() {
      return socket?.destroyed;
    },
  };
}

for (const failHostClose of [undefined, "sync", "async"]) {
  test(`real socket closes after ${failHostClose ?? "successful"} host cleanup`, async (t) => {
    const f = await fixture(t, { failHostClose });
    const helper = await createConfiguredBillHelper(f.args);
    assert.equal(await f.options.target.execute("request"), "request");
    assert.deepEqual(await helper.describeHelper({ actorId: "owner" }), {
      kind: "fixture",
    });
    const first = helper.close();
    assert.equal(helper.close(), first);
    if (failHostClose) await assert.rejects(first, AggregateError);
    else await first;
    assert.equal(f.disconnected, true);
    assert.deepEqual(f.events, ["connected", "host close", "stop"]);
    assert.equal(await helper.describeHelper({ actorId: "owner" }), null);
  });
}

test("startup and both cleanup failures retain causes and still close the socket", async (t) => {
  const f = await fixture(t, {
    failStart: true,
    failHostClose: "async",
    failStop: true,
  });
  await assert.rejects(createConfiguredBillHelper(f.args), (error) => {
    assert.equal(error.cause.message, "start failed");
    assert.deepEqual(
      error.errors[1].errors.map((item) => item.message),
      ["host close rejected", "stop failed"],
    );
    return true;
  });
  assert.equal(f.disconnected, true);
  assert.deepEqual(f.events, ["connected", "host close", "stop"]);
});

test("host construction failure releases the native target before propagating", async (t) => {
  const f = await fixture(t, { failHostCreate: true });
  await assert.rejects(
    createConfiguredBillHelper(f.args),
    /host construction failed/,
  );
  assert.deepEqual(f.events, ["stop"]);
});

test("evidence persists only host-projected fields with private permissions and owner/goal fences", async (t) => {
  const f = await fixture(t);
  const helper = await createConfiguredBillHelper(f.args);
  const task = { id: "task", owner: { actorId: "owner" }, goalRef: "goal" };
  const ref = await f.options.recordEvidence(
    task,
    {},
    { text: "excluded" },
    {},
    "observed",
  );
  assert.match(ref, /^evidence:[\da-f-]+$/);
  const [file] = await readdir(f.args.evidenceDirectory);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.args.evidenceDirectory, file))),
    { taskId: "task", status: "observed" },
  );
  assert.equal(
    (await stat(join(f.args.evidenceDirectory, file))).mode & 0o777,
    0o600,
  );
  await assert.rejects(
    f.options.recordEvidence(
      { ...task, owner: { actorId: "other" } },
      {},
      {},
      {},
      "observed",
    ),
    /Unconfigured/,
  );
  assert.equal((await readdir(f.args.evidenceDirectory)).length, 1);
  await helper.close();
});

test("nonprivate evidence directory rejects startup before native connection", async (t) => {
  const f = await fixture(t);
  f.args.evidenceDirectory = f.root;
  await chmod(f.root, 0o755);
  await assert.rejects(createConfiguredBillHelper(f.args), /must be private/);
  assert.deepEqual(f.events, []);
});

test("shutdown fences a description waiting for account validation", async (t) => {
  const f = await fixture(t);
  let release;
  f.args.credentialGate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const helper = await createConfiguredBillHelper(f.args);
  const description = helper.describeHelper({ actorId: "owner" });
  await helper.close();
  release("owner");
  assert.equal(await description, null);
  assert.equal(f.disconnected, true);
});

test("readback stores only projected evidence after a conclusive result", async (t) => {
  const f = await fixture(t);
  let status = "unknown";
  f.args.hostPolicy.reconcileMethod = async () => ({
    status,
    rawPage: "private",
  });
  f.args.hostPolicy.reconciliationEvidenceRecord = ({
    task,
    proposal,
    status,
  }) => ({ taskId: task.id, operationId: proposal.id, status });
  const helper = await createConfiguredBillHelper(f.args);
  try {
    const input = {
      task: { id: "task", owner: { actorId: "owner" }, goalRef: "goal" },
      proposal: { id: "selection" },
      snapshot: { text: "private" },
    };
    assert.deepEqual(await f.options.reconcileMethod(input), {
      status: "unknown",
    });
    assert.deepEqual(await readdir(f.args.evidenceDirectory), []);
    status = "succeeded";
    const result = await f.options.reconcileMethod(input);
    assert.equal(result.status, "succeeded");
    assert.match(result.evidenceRef, /^evidence:/);
    const [file] = await readdir(f.args.evidenceDirectory);
    assert.deepEqual(
      JSON.parse(await readFile(join(f.args.evidenceDirectory, file), "utf8")),
      { taskId: "task", operationId: "selection", status: "succeeded" },
    );
    assert.equal(
      (await stat(join(f.args.evidenceDirectory, file))).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      f.options.reconcileMethod({
        ...input,
        task: { ...input.task, goalRef: "other" },
      }),
      /Unconfigured/,
    );
    status = "anything";
    await assert.rejects(
      f.options.reconcileMethod(input),
      /Invalid bill reconciliation/,
    );
    assert.equal((await readdir(f.args.evidenceDirectory)).length, 1);
  } finally {
    await helper.close();
  }
});

test("registration wait rechecks account and profile before binding and is cancelled by close", async (t) => {
  for (const scenario of ["ready", "account", "profile", "close"]) {
    const f = await fixture(t);
    let release,
      entered,
      owner = "owner",
      profile = "profile",
      binds = 0;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    class Target extends f.args.runtimeModule.NativeSocketBrowserTarget {
      getProfileId() {
        return profile;
      }
      async waitForProfile(expected, { signal }) {
        assert.equal(expected, "profile");
        entered();
        await new Promise((resolve, reject) => {
          release = resolve;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
      async bindTask() {
        binds++;
        return "bound";
      }
    }
    f.args.runtimeModule = { NativeSocketBrowserTarget: Target };
    f.args.credentialGate = async () => owner;
    const helper = await createConfiguredBillHelper(f.args);
    const pending = f.options.target.bindTask({ revoked: false });
    const result = scenario === "ready" ? pending : assert.rejects(pending);
    await waiting;
    assert.equal(binds, 0);
    if (scenario === "account") owner = "replacement";
    if (scenario === "profile") profile = "different";
    if (scenario === "close") await helper.close();
    else release();
    if (scenario === "ready") assert.equal(await result, "bound");
    else await result;
    assert.equal(binds, scenario === "ready" ? 1 : 0);
    await helper.close();
  }
});

test("revocation and ordinary commands never wait for registration or retry", async (t) => {
  const f = await fixture(t);
  let waits = 0,
    binds = 0;
  class Target extends f.args.runtimeModule.NativeSocketBrowserTarget {
    async waitForProfile() {
      waits++;
      throw new Error("must not wait");
    }
    async bindTask() {
      binds++;
      return "revoked";
    }
  }
  f.args.runtimeModule = { NativeSocketBrowserTarget: Target };
  const helper = await createConfiguredBillHelper(f.args);
  try {
    assert.equal(await f.options.target.bindTask({ revoked: true }), "revoked");
    assert.equal(await f.options.target.execute("once"), "once");
    assert.equal(waits, 0);
    assert.equal(binds, 1);
  } finally {
    await helper.close();
  }
});

test("configured emailed-code policy reaches the helper and fills only one current code", async (t) => {
  const f = await fixture(t);
  const bundle = join(f.root, "task-runtime.mjs");
  buildTaskRuntime(bundle);
  const { GoogleTaskCodeResolver } = await import(pathToFileURL(bundle));
  let connected = "grant-a";
  const mailbox = new Map();
  const reads = [];
  const summary = (externalId) => ({
    externalId,
    fromEmail: "security@biller.example",
    to: ["person@example.org"],
    receivedAt: new Date().toISOString(),
  });
  const googleReadPort = {
    currentAccountId: async () => connected,
    async searchGmailMessagesPage(input) {
      reads.push(input.accountId);
      return {
        messages: [...mailbox.keys()].map(summary),
        nextPageToken: null,
      };
    },
    async getGmailMessageDetail(input) {
      reads.push(input.accountId);
      return {
        message: summary(input.messageId),
        bodyText: mailbox.get(input.messageId),
      };
    },
  };
  const parse = (detail) => {
    const [challengeId, code, expiresAt] = detail.bodyText.split(" ");
    return { challengeId, code, expiresAt: Number(expiresAt) };
  };
  const challengeForBill = async () => ({
    targetRef: "otp",
    challengeId: "challenge",
    recipient: "person@example.org",
    senders: ["security@biller.example"],
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    searchQuery: "challenge",
  });
  f.args.googleReadPort = googleReadPort;
  f.args.configuration = {
    ...f.args.configuration,
    googleSource: { senders: ["bills@example.org"] },
    bill: {
      company: "Example",
      accountLabel: "1234",
      origin: "https://biller.example",
    },
  };
  f.args.hostPolicy = {
    ...f.args.hostPolicy,
    parseMessage: () => null,
    googleCode: { parse, challengeForBill },
  };
  const helper = await createConfiguredBillHelper(f.args);
  t.after(() => helper.close().catch(() => {}));
  const { google } = f.options;
  assert.equal(google.service, googleReadPort);
  assert.equal(google.parse, parse);
  assert.equal(google.challengeForBill, challengeForBill);

  const owner = {
    actorId: "owner",
    agentId: "agent",
    connector: { accountId: "owner" },
  };
  const task = {
    id: "task",
    epoch: 1,
    revision: 1,
    status: "active",
    goalRef: "goal",
    owner,
    authorization: { state: "active", decisionId: "grant" },
    operations: [],
  };
  // The task epoch binds the Google account connected when it first reads.
  assert.equal(await google.accountForTask(task), "grant-a");
  connected = "grant-b";
  assert.equal(await google.accountForTask(task), "grant-a");
  assert.equal(await google.accountForTask({ ...task, epoch: 2 }), "grant-b");
  connected = "grant-a";
  await assert.rejects(
    google.accountForTask({ ...task, goalRef: "other" }),
    /Unconfigured bill task/,
  );

  const filled = [];
  let coordinator;
  const runtime = {
    owner,
    get: () => structuredClone(task),
    observe: async () => {},
    execute: async (_id, _revision, proposal) => {
      const value = await coordinator.resolveValue(proposal.valueRef, task);
      filled.push(value.text);
      task.operations.push({ proposal, status: "succeeded" });
      task.revision++;
      return structuredClone(task);
    },
  };
  coordinator = new BillCodeCoordinator({
    deriveBillDecision,
    controls,
    runtime,
    actuator: {
      readObservation: () => ({
        snapshot: {
          url: "https://biller.example/",
          text: "Environment: Controlled test biller\nCompany: Example\nSession: Signed in\nVerification: Required",
          elements: [{ selector: "otp" }],
        },
        observation: { id: "observation", version: 1, inputRevision: 0 },
      }),
    },
    resolver: new GoogleTaskCodeResolver({
      google: google.service,
      parse: google.parse,
      authorize: async (context) =>
        context.accountId === (await google.accountForTask(task)),
    }),
    challengeProvider: google.challengeForBill,
    resolveGoogleAccount: google.accountForTask,
  });
  const bill = {
    origin: "https://biller.example",
    sourceRef: "mail:bill",
    company: "Example",
    amountMinor: 100,
  };
  const fill = () => coordinator.fill({ taskId: task.id, bill });
  const later = Date.now() + 60000;

  assert.match((await fill()).message, /No matching code/);
  mailbox.set("old", `challenge 111111 ${Date.now() - 1}`);
  assert.match((await fill()).message, /expired/);
  mailbox.set("a", `challenge 222222 ${later}`);
  mailbox.set("b", `challenge 333333 ${later}`);
  assert.match((await fill()).message, /More than one code/);
  assert.deepEqual(filled, []);
  mailbox.delete("b");
  const result = await fill();
  assert.match(result.message, /press Verify yourself/);
  assert.equal(JSON.stringify(result).includes("222222"), false);
  assert.deepEqual(filled, ["222222"]);
  // Every code read named the bound grant, not another connected mailbox.
  assert.deepEqual(new Set(reads), new Set(["grant-a"]));
});

test("an emailed-code policy without a Google source or parser is refused", async (t) => {
  const f = await fixture(t);
  f.args.hostPolicy = {
    ...f.args.hostPolicy,
    googleCode: { parse: () => null, challengeForBill: async () => null },
  };
  await assert.rejects(
    createConfiguredBillHelper(f.args),
    /Incomplete Google verification configuration/,
  );
  f.args.configuration = { ...f.args.configuration, googleSource: {} };
  f.args.googleReadPort = {};
  f.args.hostPolicy.googleCode = { challengeForBill: async () => null };
  await assert.rejects(
    createConfiguredBillHelper(f.args),
    /Incomplete Google verification configuration/,
  );
});
