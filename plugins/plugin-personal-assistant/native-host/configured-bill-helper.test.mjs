import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
