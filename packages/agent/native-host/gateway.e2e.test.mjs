import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRuntimeAccountState } from "./account-state.mjs";
import { createLocalAgentGateway } from "./gateway.mjs";
import { createRuntimeSupervisor } from "./runtime-supervisor.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const policy = {
  origins: ["https://example.org"],
  resetPaths: ["/identity/logout"],
  conversationTitle: "Independent Host",
  abortReason: "user-stop",
  validateTitle() {},
  isPaidAction: () => false,
  prepareMessage: (input) => ({
    body: { text: input.text, metadata: { product: "independent" } },
  }),
  formatTaskContext: () => "",
};
async function listen(server) {
  server.keepAliveTimeout = 0;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
test("independent host HTTP authentication, disk ownership restart, stale-account response and revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-host-e2e-"));
  let owner = "a",
    rotate = false;
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({
      url: req.url,
      token: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("Content-Type", "application/json");
    if (rotate) owner = "b";
    res.end(
      JSON.stringify(
        req.url === "/api/conversations"
          ? { conversation: { id, roomId: id } }
          : { text: "private-reply" },
      ),
    );
  });
  const target = await listen(upstream);
  const file = join(root, "owners.json");
  const store = {
    read: async () => {
      try {
        return await readFile(file, "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    write: (value) => writeFile(file, value, { mode: 0o600 }),
  };
  const make = () =>
    createLocalAgentGateway({
      hostPolicy: policy,
      upstream: target,
      token: "upstream-authority",
      inboundToken: "host-authority",
      ownershipStore: store,
      credentialGate: async () => owner,
      cloudHandler: async (req, res, url, { json }) => {
        if (url.pathname !== "/identity/logout") return false;
        json(res, 200, { disconnected: true });
        return true;
      },
    });
  let server = make(),
    base = await listen(server);
  const post = (path, body = {}, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer host-authority",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + "/health")).status, 401);
    assert.equal(requests.length, 0);
    assert.equal(
      (
        await post(
          "/conversations",
          {},
          { Origin: "https://untrusted.example" },
        )
      ).status,
      403,
    );
    assert.equal(requests.length, 0);
    assert.equal((await post("/conversations")).status, 200);
    assert.equal(requests[0].body.title, "Independent Host");
    assert.equal(requests[0].token, "Bearer upstream-authority");
    assert.equal(JSON.parse(await readFile(file, "utf8"))[0].owner, "a");
    await close(server);
    server = make();
    base = await listen(server);
    assert.equal(
      (await post(`/conversations/${id}/messages`, { text: "hello" })).status,
      200,
    );
    assert.equal(requests.at(-1).body.metadata.product, "independent");
    rotate = true;
    const stale = await post(`/conversations/${id}/messages`, {
      text: "hello",
    });
    assert.equal(stale.status, 409);
    assert.doesNotMatch(await stale.text(), /private-reply/);
    const count = requests.length;
    assert.equal(
      (await post(`/conversations/${id}/messages`, { text: "hello" })).status,
      409,
    );
    assert.equal(requests.length, count);
    assert.equal((await post("/identity/logout")).status, 200);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
  } finally {
    await close(server);
    await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});
test("runtime supervisor starts real processes in isolated account storage and stops only its child", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-runtime-e2e-"));
  let owner = "first";
  const children = [];
  const supervisor = createRuntimeSupervisor({
    readIdentity: async () => owner,
    start: async (credential) => {
      const { state } = await prepareRuntimeAccountState(root, credential);
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { cwd: state, stdio: "ignore" },
      );
      await once(child, "spawn");
      children.push(child);
      return child;
    },
    stop: async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  });
  try {
    await supervisor.reconcile();
    const first = children[0];
    owner = "second";
    await supervisor.reconcile();
    assert.notEqual(first.pid, children[1].pid);
    assert.equal(first.signalCode, "SIGTERM");
    const a = await prepareRuntimeAccountState(root, "first"),
      b = await prepareRuntimeAccountState(root, "second");
    assert.notEqual(a.state, b.state);
    await supervisor.close();
    assert.equal(children[1].signalCode, "SIGTERM");
  } finally {
    await supervisor.close();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

for (const transition of ["reset", "rotate"]) {
  test(`request admission rechecks account after task presentation: ${transition}`, async () => {
    let owner = "first";
    let messageRequests = 0;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const upstream = http.createServer((req, res) => {
      if (req.url.endsWith("/messages")) messageRequests++;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ conversation: { id, roomId: id }, text: "reply" }),
      );
    });
    const target = await listen(upstream);
    const gateway = createLocalAgentGateway({
      upstream: target,
      token: "upstream-authority",
      inboundToken: "host-authority",
      credentialGate: async () => owner,
      hostPolicy: {
        ...policy,
        prepareMessage: (input) => ({
          body: { text: input.text },
          chatTask: { id: "task" },
        }),
      },
      taskGateway: {
        revoke: async () => {},
        presentationForConversation: async () => {
          entered.resolve();
          await release.promise;
          return { choice: null };
        },
      },
      cloudHandler: async (req, res, url, { json }) => {
        if (url.pathname !== "/identity/logout") return false;
        json(res, 200, { disconnected: true });
        return true;
      },
    });
    const base = await listen(gateway);
    const post = (path, body = {}) =>
      fetch(base + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer host-authority",
        },
        body: JSON.stringify(body),
      });
    try {
      assert.equal((await post("/conversations")).status, 200);
      const pending = post(`/conversations/${id}/messages`, { text: "hello" });
      await entered.promise;
      if (transition === "reset")
        assert.equal((await post("/identity/logout")).status, 200);
      else owner = "second";
      release.resolve();
      assert.equal((await pending).status, 409);
      assert.equal(messageRequests, 0);
    } finally {
      release.resolve();
      await close(gateway);
      await close(upstream);
    }
  });
}
