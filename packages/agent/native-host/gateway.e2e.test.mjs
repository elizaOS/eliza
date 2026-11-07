import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRuntimeAccountState } from "./account-state.mjs";
import { createLocalAgentGateway } from "./gateway.mjs";
import {
  preparePrivateRuntimeFiles,
  preparePrivateRuntimeProfile,
  readPrivateRuntimeEnvironment,
  readPrivateRuntimeJson,
  runtimeEnvironment,
  startPrivateRuntimeProcess,
  writePrivateRuntimeJson,
} from "./private-runtime-launch.mjs";
import { createRuntimeSupervisor } from "./runtime-supervisor.mjs";
import { createSurfaceCommandChannel } from "./surface-channel.mjs";

test("private launch persists token, preserves user config and isolates actual child environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environmentFile = join(root, "runtime.env");
  await writeFile(
    environmentFile,
    '# private\nexport PROVIDER_KEY="synthetic-key"\nLITERAL=$(touch never)\nAUTH=wrong\n',
  );
  const settings = await readPrivateRuntimeEnvironment(environmentFile);
  const configPath = join(root, "config.json");
  const launchConfigPath = join(root, "launch.json");
  const options = {
    tokenPath: join(root, "token"),
    configPath,
    launchConfigPath,
    initialConfig: { provider: "old", userPreference: true },
    selectConfig: (existing) => ({ ...existing, provider: "selected" }),
  };
  const first = await preparePrivateRuntimeFiles(options);
  const second = await preparePrivateRuntimeFiles({
    ...options,
    initialConfig: { discarded: true },
  });
  assert.equal(first.token, second.token);
  assert.equal(first.token.length, 64);
  assert.deepEqual(
    JSON.parse(await readFile(configPath)),
    options.initialConfig,
  );
  assert.equal(
    JSON.parse(await readFile(launchConfigPath)).provider,
    "selected",
  );
  for (const file of [options.tokenPath, configPath, launchConfigPath])
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const output = join(root, "observed.json");
  const signals = new EventEmitter();
  const running = await startPrivateRuntimeProcess({
    command: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
      output,
    ],
    cwd: root,
    stdio: "ignore",
    signalSource: signals,
    env: runtimeEnvironment({
      inherited: { HOME: root, UNGRANTED: "hidden" },
      allow: ["HOME"],
      settings,
      owned: { AUTH: first.token },
      remove: ["PROVIDER_KEY"],
    }),
    recordLaunch: (binding) =>
      writePrivateRuntimeJson(join(root, "binding.json"), binding),
  });
  assert.deepEqual(await running.completion, {
    code: 0,
    signal: null,
    error: null,
  });
  const observed = JSON.parse(await readFile(output));
  assert.equal(observed.AUTH, first.token);
  assert.equal(observed.LITERAL, "$(touch never)");
  assert.equal(observed.UNGRANTED, undefined);
  assert.equal(observed.PROVIDER_KEY, undefined);
  assert.equal(observed.HOME, root);
  assert.equal(
    JSON.parse(await readFile(join(root, "binding.json"))).pid,
    running.child.pid,
  );
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("host token format is selected only on creation and survives default reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-launch-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let generated = 0;
  const options = {
    tokenPath: join(root, "token"),
    configPath: join(root, "config.json"),
    launchConfigPath: join(root, "launch.json"),
    initialConfig: {},
    selectConfig: (existing) => existing,
  };
  const createToken = () => {
    generated++;
    return randomBytes(32).toString("hex");
  };
  const first = await preparePrivateRuntimeFiles({ ...options, createToken });
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(
    (await preparePrivateRuntimeFiles({ ...options, createToken })).token,
    first.token,
  );
  assert.equal((await preparePrivateRuntimeFiles(options)).token, first.token);
  assert.equal(generated, 1);
  assert.equal((await stat(options.tokenPath)).mode & 0o777, 0o600);
});

test("persistent profile preserves runtime-written configuration and its exact bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-runtime-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    tokenPath: join(root, "token"),
    configPath: join(root, "config.json"),
    initialConfig: { provider: "default" },
  };
  const first = await preparePrivateRuntimeProfile(options);
  assert.deepEqual(first.config, options.initialConfig);
  const updated = ' { "provider": "runtime selection", "setting": true }\n';
  await writeFile(options.configPath, updated);
  const restored = await preparePrivateRuntimeProfile({
    ...options,
    initialConfig: { provider: "discarded" },
  });
  assert.equal(restored.token, first.token);
  assert.deepEqual(restored.config, JSON.parse(updated));
  assert.equal(await readFile(options.configPath, "utf8"), updated);
  assert.equal((await stat(options.configPath)).mode & 0o777, 0o600);
});

test("a failed token factory does not poison later private profile preparation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-launch-token-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    tokenPath: join(root, "token"),
    configPath: join(root, "config.json"),
    launchConfigPath: join(root, "launch.json"),
    initialConfig: {},
    selectConfig: (existing) => existing,
  };
  const failure = new Error("controlled token factory failure");
  await assert.rejects(
    preparePrivateRuntimeFiles({
      ...options,
      createToken: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(stat(options.tokenPath), { code: "ENOENT" });
  for (const invalid of ["", "  ", "line\nbreak", undefined]) {
    await assert.rejects(
      preparePrivateRuntimeFiles({ ...options, createToken: () => invalid }),
      { code: "INVALID_RUNTIME_TOKEN" },
    );
    await assert.rejects(stat(options.tokenPath), { code: "ENOENT" });
  }
  const restored = await preparePrivateRuntimeFiles({
    ...options,
    createToken: () => "fixture-token",
  });
  assert.equal(restored.token, "fixture-token");
  assert.equal((await stat(options.tokenPath)).mode & 0o777, 0o600);
});

test("private launch rejects malformed settings, links and empty authority without spawning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "runtime.env");
  assert.deepEqual(
    await readPrivateRuntimeEnvironment(file, { optional: true }),
    {},
  );
  await assert.rejects(readPrivateRuntimeEnvironment(file), { code: "ENOENT" });
  await writeFile(file, "SECRET=value\nnot an assignment\n");
  await assert.rejects(readPrivateRuntimeEnvironment(file), {
    code: "INVALID_PRIVATE_ENVIRONMENT",
  });
  await writeFile(join(root, "target"), "untouched");
  const tokenPath = join(root, "token");
  await symlink(join(root, "target"), tokenPath);
  const options = {
    tokenPath,
    configPath: join(root, "config"),
    launchConfigPath: join(root, "launch"),
    initialConfig: {},
    selectConfig: (x) => x,
  };
  await assert.rejects(preparePrivateRuntimeFiles(options));
  assert.equal(await readFile(join(root, "target"), "utf8"), "untouched");
  await rm(tokenPath);
  await writeFile(tokenPath, "  ");
  await assert.rejects(preparePrivateRuntimeFiles(options), {
    code: "INVALID_RUNTIME_TOKEN",
  });
});

test("failed launch receipt reaps its actual child and removes signal handlers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "failed-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let pid;
  const signals = new EventEmitter();
  await assert.rejects(
    startPrivateRuntimeProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root,
      env: {},
      stdio: "ignore",
      signalSource: signals,
      stopTimeoutMs: 100,
      recordLaunch: async (binding) => {
        pid = binding.pid;
        await writePrivateRuntimeJson(join(root, "absent", "binding"), binding);
      },
    }),
    { code: "ENOENT" },
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("missing executable rejects without an unhandled child error or signal leak", async () => {
  const signals = new EventEmitter();
  await assert.rejects(
    startPrivateRuntimeProcess({
      command: "/nonexistent-private-launch-executable",
      args: [],
      env: {},
      stdio: "ignore",
      signalSource: signals,
    }),
    { code: "RUNTIME_PROCESS_FAILED" },
  );
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("signal during receipt cancels admission and kills a child that ignores TERM", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "signal-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ready = join(root, "ready");
  const signals = new EventEmitter();
  let pid;
  await assert.rejects(
    startPrivateRuntimeProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)",
        ready,
      ],
      env: {},
      stdio: "ignore",
      signalSource: signals,
      stopTimeoutMs: 50,
      recordLaunch: async (binding) => {
        pid = binding.pid;
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await readFile(ready);
            break;
          } catch (error) {
            if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        signals.emit("SIGTERM");
      },
    }),
    { code: "RUNTIME_LAUNCH_CANCELLED" },
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

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
test("sign-out stops a room's turn even after its request closed, and only rooms sent a message", async () => {
  const requests = [];
  const held = [];
  // A second conversation that is never sent a message has no turn to stop.
  const idle = "22222222-2222-4222-8222-222222222222";
  let conversations = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    res.setHeader("Content-Type", "application/json");
    // The turn runs upstream until it is aborted; its reply never comes.
    if (req.url.endsWith("/messages")) return held.push(res);
    res.end(
      JSON.stringify(
        req.url === "/api/conversations"
          ? ++conversations === 1
            ? { conversation: { id, roomId: id } }
            : { conversation: { id: idle, roomId: idle } }
          : { aborted: true },
      ),
    );
  });
  const target = await listen(upstream);
  const server = createLocalAgentGateway({
    hostPolicy: policy,
    upstream: target,
    token: "upstream-authority",
    inboundToken: "host-authority",
    credentialGate: async () => "a",
    cloudHandler: async (_req, res, url, { json }) => {
      if (url.pathname !== "/identity/logout") return false;
      json(res, 200, { disconnected: true });
      return true;
    },
  });
  const base = await listen(server);
  const post = (path, body = {}, signal) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer host-authority",
      },
      body: JSON.stringify(body),
      signal,
    });
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  try {
    assert.equal((await post("/conversations")).status, 200);
    assert.equal((await post("/conversations")).status, 200);
    const renderer = new AbortController();
    const message = post(
      `/conversations/${id}/messages`,
      { text: "hello" },
      renderer.signal,
    ).catch(() => null);
    await until(() => held.length === 1);
    // The renderer goes away (reload, closed panel) while the turn runs.
    renderer.abort();
    await message;
    await until(() => held[0].destroyed || held[0].writableEnded);
    assert.equal((await post("/identity/logout")).status, 200);
    await until(() => requests.some((r) => r.url === `/api/turns/${id}/abort`));
    assert.deepEqual(
      requests.filter((r) => r.url.endsWith("/abort")),
      [{ url: `/api/turns/${id}/abort`, body: { reason: "cloud-logout" } }],
    );
  } finally {
    for (const res of held) res.destroy();
    await close(server);
    await close(upstream);
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

const predicatePolicy = {
  ...policy,
  origins: undefined,
  isAllowedOrigin: (origin) => {
    if (origin === "https://policy-error.example")
      throw new Error("policy failed");
    return origin === "https://example.org";
  },
};
const preflightBeforeAuthentication = (hostPolicy) => async () => {
  const gateway = createLocalAgentGateway({
    hostPolicy,
    upstream: "http://127.0.0.1:9",
    token: "upstream-authority",
    inboundToken: "host-authority",
  });
  const base = await listen(gateway);
  // A browser preflight: Origin and Access-Control-Request-*, no Authorization.
  const options = (origin, extra = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(`${base}/conversations`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
          ...extra,
        },
      });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    const granted = await options("https://example.org");
    assert.equal(granted.statusCode, 204);
    assert.equal(
      granted.headers["access-control-allow-origin"],
      "https://example.org",
    );
    assert.match(
      granted.headers["access-control-allow-headers"],
      /\bAuthorization\b/,
    );
    assert.equal((await options("https://untrusted.example")).statusCode, 403);
    assert.equal(
      (await options("https://policy-error.example")).statusCode,
      403,
    );
    assert.equal(
      (await options("https://example.org", { Host: "attacker.example" }))
        .statusCode,
      403,
    );
    // Everything but a preflight still needs the bearer token.
    const unauthenticated = await fetch(`${base}/conversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.org",
      },
      body: "{}",
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    await close(gateway);
  }
};
test(
  "allowlisted renderer preflight is answered before bearer authentication",
  preflightBeforeAuthentication(policy),
);
test("an origin predicate gates the renderer preflight like an origin list", async () => {
  // A host gives an origin list or an origin predicate, never both.
  assert.throws(
    () =>
      createLocalAgentGateway({
        hostPolicy: {
          ...policy,
          isAllowedOrigin: predicatePolicy.isAllowedOrigin,
        },
        token: "upstream-authority",
      }),
    /Explicit gateway host policy is required/,
  );
  await preflightBeforeAuthentication(predicatePolicy)();
});

test("a host request scope wraps each whole request, also its later async work", async () => {
  const scope = new AsyncLocalStorage();
  const seen = [];
  let count = 0;
  const gateway = createLocalAgentGateway({
    hostPolicy: policy,
    upstream: "http://127.0.0.1:9",
    token: "upstream-authority",
    inboundToken: "host-authority",
    requestScope: (req, _res, next) => {
      if (req.url === "/fail-scope") throw new Error("host scope failed");
      return scope.run({ request: ++count }, next);
    },
    fetchImpl: async () => {
      seen.push(scope.getStore()?.request);
      // Let the other request run before this one answers.
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen.push(scope.getStore()?.request);
      return Response.json({});
    },
  });
  const base = await listen(gateway);
  try {
    const call = (path) =>
      fetch(`${base}${path}`, {
        headers: { Authorization: "Bearer host-authority" },
      });
    const answers = await Promise.all([call("/health"), call("/health")]);
    assert.deepEqual(
      answers.map(({ status }) => status),
      [200, 200],
    );
    assert.deepEqual(seen.toSorted(), [1, 1, 2, 2]);
    // Both requests were waiting at once, and each one kept its own scope.
    assert.deepEqual(seen.slice(0, 2).toSorted(), [1, 2]);
    assert.deepEqual(seen.slice(2), seen.slice(0, 2));
    const failed = await call("/fail-scope");
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Local agent unavailable" });
    assert.equal((await call("/health")).status, 200);
  } finally {
    await close(gateway);
  }
  assert.throws(
    () =>
      createLocalAgentGateway({
        hostPolicy: policy,
        token: "upstream-authority",
        requestScope: "scope",
      }),
    TypeError,
  );
});

test("a rejecting async request scope answers 500 once and never runs the handler twice", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  let handled = 0;
  let lateNext;
  const gateway = createLocalAgentGateway({
    hostPolicy: policy,
    upstream: "http://127.0.0.1:9",
    token: "upstream-authority",
    inboundToken: "host-authority",
    requestScope: async (req, _res, next) => {
      await Promise.resolve();
      if (req.headers["x-test-case"] === "reject-before") {
        lateNext = next;
        throw new Error("host scope rejected");
      }
      if (req.headers["x-test-case"] === "reject-after") {
        await next();
        throw new Error("host scope rejected after the handler");
      }
      if (req.headers["x-test-case"] === "twice") {
        await next();
        return next();
      }
      return next();
    },
    fetchImpl: async () => {
      handled += 1;
      return Response.json({});
    },
  });
  const base = await listen(gateway);
  try {
    const call = (testCase = "plain") =>
      fetch(`${base}/health`, {
        headers: {
          Authorization: "Bearer host-authority",
          "X-Test-Case": testCase,
        },
        // Without an answer the request would hang; fail instead.
        signal: AbortSignal.timeout(5_000),
      });
    const rejected = await call("reject-before");
    assert.equal(rejected.status, 500);
    assert.deepEqual(await rejected.json(), {
      error: "Local agent unavailable",
    });
    assert.equal(handled, 0);
    // A failed scope cannot start the handler later.
    assert.throws(() => lateNext(), /Request handler already started/);
    assert.equal(handled, 0);
    // A rejection after the handler answered does not answer again.
    assert.equal((await call("reject-after")).status, 200);
    assert.equal(handled, 1);
    assert.equal((await call("twice")).status, 200);
    assert.equal(handled, 2);
    assert.equal((await call()).status, 200);
    assert.equal(handled, 3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await close(gateway);
  }
});

test("read-only private JSON enforces real file owner, mode, symlink and byte boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-json-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  const value = { message: "é", enabled: true };
  const text = JSON.stringify(value);
  const maxBytes = Buffer.byteLength(text);
  await writeFile(file, text, { mode: 0o600 });
  assert.deepEqual(await readPrivateRuntimeJson(file, { maxBytes }), value);
  await assert.rejects(
    readPrivateRuntimeJson(file, { maxBytes: maxBytes - 1 }),
    { code: "INVALID_PRIVATE_FILE" },
  );
  await assert.rejects(
    readPrivateRuntimeJson(file, { maxBytes, ownerUid: process.getuid() + 1 }),
    { code: "INVALID_PRIVATE_FILE" },
  );
  await chmod(file, 0o640);
  await assert.rejects(readPrivateRuntimeJson(file, { maxBytes }), {
    code: "INVALID_PRIVATE_FILE",
  });
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  await chmod(file, 0o600);
  const link = join(root, "link");
  await symlink(file, link);
  await assert.rejects(readPrivateRuntimeJson(link, { maxBytes }));
  const directory = join(root, "directory");
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(readPrivateRuntimeJson(directory, { maxBytes }), {
    code: "INVALID_PRIVATE_FILE",
  });
  await assert.rejects(
    readPrivateRuntimeJson(join(root, "missing"), { maxBytes }),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(file, "utf8"), text);
  const large = { value: "é".repeat(40000) };
  const largeText = JSON.stringify(large);
  await writeFile(file, largeText);
  await chmod(file, 0o400);
  assert.deepEqual(
    await readPrivateRuntimeJson(file, {
      maxBytes: Buffer.byteLength(largeText),
    }),
    large,
  );
  assert.equal((await stat(file)).mode & 0o777, 0o400);
});

test("private JSON rejects invalid policy and parse errors without creating or repairing files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-json-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "invalid.json");
  await writeFile(file, "{", { mode: 0o600 });
  for (const options of [
    {},
    { maxBytes: 0 },
    { maxBytes: 1.5 },
    { maxBytes: Infinity },
    { maxBytes: 2147483648 },
    { maxBytes: 10, ownerUid: -1 },
  ]) {
    await assert.rejects(readPrivateRuntimeJson(file, options), {
      code: "INVALID_PRIVATE_FILE_POLICY",
    });
  }
  await assert.rejects(readPrivateRuntimeJson("relative", { maxBytes: 10 }), {
    code: "INVALID_PRIVATE_FILE_POLICY",
  });
  await assert.rejects(
    readPrivateRuntimeJson(file, { maxBytes: 10 }),
    SyntaxError,
  );
  await writeFile(file, "null");
  assert.equal(await readPrivateRuntimeJson(file, { maxBytes: 4 }), null);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("private JSON rejects a real FIFO without blocking on a writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "private-json-fifo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fifo");
  execFileSync("mkfifo", ["-m", "600", file]);
  const moduleUrl = new URL("./private-runtime-launch.mjs", import.meta.url)
    .href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { readPrivateRuntimeJson } = await import(process.argv[1]);
    try { await readPrivateRuntimeJson(process.argv[2], {maxBytes: 32}); process.exitCode = 1; }
    catch (error) { if (error.code !== "INVALID_PRIVATE_FILE") throw error; }
  `,
      moduleUrl,
      file,
    ],
    { timeout: 5000 },
  );
});

test("embedded surface HTTP channel fences account replacement, cancellation, late replies and complete observations", async () => {
  let account = "owner-a";
  const channel = createSurfaceCommandChannel({
    credentialGate: async () => account,
    pullHoldMs: 100,
  });
  const server = createLocalAgentGateway({
    token: "agent-authority",
    inboundToken: "host-authority",
    hostPolicy: policy,
    surfaceChannel: channel,
  });
  const origin = await listen(server);
  const send = async (path, body, token = "host-authority") => {
    const response = await fetch(`${origin}/browser/surface/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal(
      (await send("connect", { clientId: "a", epoch: 1 }, "wrong")).status,
      401,
    );
    const a = (await send("connect", { clientId: "a", epoch: 1 })).body;
    const controller = new AbortController();
    const notSent = channel.request(
      { subaction: "click" },
      { effect: true, signal: controller.signal },
    );
    const notSentFailure = assert.rejects(notSent, { code: "STALE_REF" });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await notSentFailure;
    assert.equal((await send("pull", a)).body.command, null);
    const effect = channel.request({ subaction: "fill" }, { effect: true });
    const uncertain = assert.rejects(effect, { code: "UNCERTAIN_OUTCOME" });
    const delivered = (await send("pull", a)).body.command;
    assert.equal(
      (
        await send("reply", {
          ...a,
          connectionId: "foreign",
          id: delivered.id,
          result: {},
        })
      ).status,
      409,
    );
    account = "owner-b";
    assert.equal(
      (await send("reply", { ...a, id: delivered.id, result: {} })).status,
      409,
    );
    await uncertain;
    const b = (await send("connect", { clientId: "b", epoch: 2 })).body;
    assert.equal((await send("close", a)).status, 409);
    assert.equal(
      (await send("connect", { clientId: "a", epoch: 1 })).status,
      409,
    );
    const reading = channel.request(
      { subaction: "snapshot" },
      { effect: false },
    );
    const read = (await send("pull", b)).body.command;
    const observation = {
      documentId: "fresh",
      text: "Complete page text. ".repeat(10000),
    };
    assert.equal(
      (await send("reply", { ...b, id: read.id, result: observation })).status,
      200,
    );
    assert.deepEqual(await reading, observation);
    assert.equal(
      (await send("reply", { ...b, id: read.id, result: observation })).status,
      409,
    );
    const pending = channel.request({ subaction: "click" }, { effect: true });
    const ended = assert.rejects(pending, { code: "UNCERTAIN_OUTCOME" });
    await send("pull", b);
    channel.revoke();
    await ended;
    assert.equal(
      (await send("connect", { clientId: "b", epoch: 2 })).status,
      409,
    );
  } finally {
    channel.close();
    await close(server);
  }
});

// One agent outcome, answered as the buffered JSON reply and as the event
// stream the agent writes for it (`writeConversationDoneSse`).
const agentReply = {
  text: "Hello there!",
  agentName: "Agent",
  messageId: "22222222-2222-4222-8222-222222222222",
  userMessageId: "33333333-3333-4333-8333-333333333333",
  historyRefreshRequired: true,
  actionResults: [{ action: "REPLY", success: true }],
};
async function streamHarness({ messageStream, ...options } = {}) {
  const state = {
    owner: "a",
    reply: agentReply,
    tokens: ["Hello", " there", "!"],
    status: 200,
    beforeFrame: async () => {},
    onTurn: async () => {},
    requests: [],
    closed: [],
    // null: the `done` frame; an object: that frame instead; "none": no frame.
    terminal: null,
    gateCalls: 0,
  };
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    state.requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/api/conversations") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({ conversation: { id, roomId: id, title: "t" } }),
      );
    }
    if (req.url.startsWith("/api/turns/")) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ aborted: true }));
    }
    const closed = new Promise((resolve) => res.on("close", resolve));
    state.closed.push(closed);
    await state.onTurn(req.url);
    if (state.status !== 200 || !req.url.endsWith("/stream")) {
      res.writeHead(state.status, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify(
          state.status === 200 ? state.reply : { error: "No such room" },
        ),
      );
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": heartbeat\n\n");
    let text = "";
    for (const [index, token] of state.tokens.entries()) {
      await state.beforeFrame(index);
      if (res.destroyed) return;
      text += token;
      res.write(`data: ${JSON.stringify({ type: "token", text: token })}\n\n`);
    }
    await state.beforeFrame(state.tokens.length);
    if (res.destroyed) return;
    if (state.terminal === "none") return res.end();
    if (state.terminal)
      return res.end(`data: ${JSON.stringify(state.terminal)}\n\n`);
    res.write(
      `data: ${JSON.stringify({ type: "token", fullText: text, provisional: true })}\n\n`,
    );
    const { text: fullText, ...metadata } = state.reply;
    // The terminal frame also carries fields the buffered reply leaves out.
    res.end(
      `data: ${JSON.stringify({ ...metadata, thought: "private", usage: { totalTokens: 3 }, type: "done", fullText })}\n\n`,
    );
  });
  const target = await listen(upstream);
  const gateway = createLocalAgentGateway({
    hostPolicy: policy,
    upstream: target,
    token: "upstream-authority",
    inboundToken: "host-authority",
    credentialGate: async () => {
      state.gateCalls++;
      if (state.owner instanceof Error) throw state.owner;
      return state.owner;
    },
    cloudHandler: async (_req, res, url, { json }) => {
      if (url.pathname !== "/identity/logout") return false;
      json(res, 200, { disconnected: true });
      return true;
    },
    messageStream,
    ...options,
  });
  const base = await listen(gateway);
  const post = async (path, body = {}) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer host-authority",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const route = `/conversations/${id}/messages`;
  const buffered = (text = "hello") => post(route, { text });
  const start = (text = "hello") => post(`${route}/stream/start`, { text });
  const pull = (streamId, cursor) =>
    post(`${route}/stream/pull`, { streamId, cursor });
  const cancel = (streamId) => post(`${route}/stream/cancel`, { streamId });
  // Pulls to the end; answers like the buffered route plus the text events.
  const streamed = async (text = "hello") => {
    const started = await start(text);
    if (started.status !== 200) return started;
    const events = [];
    let cursor = 0;
    let pulls = 0;
    try {
      for (;;) {
        const pulled = await pull(started.body.streamId, cursor);
        if (pulled.status !== 200) return { ...pulled, events };
        events.push(...pulled.body.events);
        cursor = pulled.body.cursor;
        pulls++;
        if (pulled.body.done)
          return { status: 200, body: pulled.body.message, events, pulls };
      }
    } finally {
      // A client frees its stream slot after the turn.
      await cancel(started.body.streamId);
    }
  };
  return {
    state,
    post,
    buffered,
    start,
    pull,
    cancel,
    streamed,
    close: async () => {
      await close(gateway);
      await close(upstream);
    },
  };
}

test("a streamed reply gives ordered text after a cursor, then the buffered reply", async () => {
  const gates = [0, 1, 2, 3].map(() => Promise.withResolvers());
  const harness = await streamHarness({
    hostPolicy: {
      ...policy,
      prepareMessage: (input) => ({
        body: { text: input.text },
        chatTask: { id: "task" },
      }),
      formatTaskContext: (presentation) => ` [${presentation.choice.id}]`,
    },
    taskGateway: {
      revoke: async () => {},
      presentationForConversation: async ({ actorId }) => ({
        choice: { id: `choice-${actorId}` },
      }),
    },
  });
  const { state, start, pull, cancel } = harness;
  try {
    assert.equal((await harness.post("/conversations")).status, 200);
    const buffered = await harness.buffered();
    assert.equal(buffered.status, 200);
    assert.deepEqual(buffered.body.taskChoices, [{ id: "choice-a" }]);
    state.beforeFrame = (index) => gates[index].promise;
    gates[0].resolve();
    const started = await start();
    assert.equal(started.status, 200);
    const { streamId } = started.body;
    // The agent receives the same message as the buffered route sends.
    assert.equal(
      state.requests.at(-1).url,
      `/api/conversations/${id}/messages/stream`,
    );
    assert.deepEqual(state.requests.at(-1).body, state.requests.at(-2).body);
    assert.equal(state.requests.at(-1).body.text, "hello [choice-a]");
    const first = await pull(streamId, 0);
    assert.deepEqual(first, {
      status: 200,
      body: { events: [{ seq: 1, text: "Hello" }], cursor: 1, done: false },
    });
    // With nothing new, a pull waits for the next text.
    const held = pull(streamId, 1);
    const early = await Promise.race([
      held.then(() => "answered"),
      new Promise((resolve) => setTimeout(resolve, 100, "waiting")),
    ]);
    assert.equal(early, "waiting");
    gates[1].resolve();
    assert.deepEqual(await held, {
      status: 200,
      body: { events: [{ seq: 2, text: " there" }], cursor: 2, done: false },
    });
    // A cursor confirms the text before it; that text is released.
    assert.equal(
      (await pull(streamId, 0)).body.code,
      "MESSAGE_STREAM_CURSOR_EXPIRED",
    );
    assert.equal((await pull(streamId, 3)).status, 400);
    assert.equal((await pull("other", 2)).status, 404);
    gates[2].resolve();
    gates[3].resolve();
    const events = [];
    let cursor = 2;
    let final;
    while (!final) {
      const { status, body } = await pull(streamId, cursor);
      assert.equal(status, 200);
      events.push(...body.events);
      cursor = body.cursor;
      if (body.done) final = body.message;
    }
    assert.deepEqual(events, [
      { seq: 3, text: "!" },
      { seq: 4, fullText: "Hello there!", provisional: true },
    ]);
    assert.deepEqual(final, buffered.body);
    assert.equal(final.thought, undefined);
    // A lost answer can be pulled again with the same cursor.
    assert.deepEqual((await pull(streamId, cursor)).body.message, final);
    assert.deepEqual((await cancel(streamId)).body, { cancelled: true });
    assert.equal((await pull(streamId, cursor)).status, 404);
  } finally {
    for (const gate of gates) gate.resolve();
    await harness.close();
  }
});

test("streamed replies are cancelled, expire and stay inside their limits", async () => {
  const harness = await streamHarness({
    messageStream: {
      idleMs: 300,
      holdMs: 100,
      coalesceMs: 20,
      maxStreams: 1,
      maxBufferedChars: 12,
    },
  });
  const { state, start, pull, cancel } = harness;
  const never = Promise.withResolvers();
  try {
    assert.equal((await harness.post("/conversations")).status, 200);
    state.beforeFrame = (index) => (index === 1 ? never.promise : undefined);
    const cancelled = (await start()).body.streamId;
    assert.equal((await pull(cancelled, 0)).body.cursor, 1);
    // An empty pull answers after its bounded hold.
    const before = Date.now();
    assert.deepEqual((await pull(cancelled, 1)).body, {
      events: [],
      cursor: 1,
      done: false,
    });
    assert.ok(Date.now() - before >= 90);
    assert.equal((await start()).body.code, "MESSAGE_STREAM_LIMIT");
    assert.equal((await cancel(cancelled)).status, 200);
    await state.closed.at(-1);
    assert.equal((await pull(cancelled, 1)).status, 404);
    // A stream nobody pulls is cancelled at the agent and released.
    const idle = (await start()).body.streamId;
    await state.closed.at(-1);
    assert.equal((await pull(idle, 0)).body.code, "MESSAGE_STREAM_NOT_FOUND");
    // Unconfirmed text has an explicit limit; it fails, never truncates.
    state.tokens = ["123456", "7890123"];
    state.beforeFrame = async () => {};
    const full = (await start()).body.streamId;
    await state.closed.at(-1);
    assert.deepEqual(await pull(full, 0), {
      status: 503,
      body: {
        code: "MESSAGE_STREAM_BUFFER_FULL",
        error: "Gateway request failed (error26)",
      },
    });
    assert.throws(
      () =>
        createLocalAgentGateway({
          hostPolicy: policy,
          token: "t",
          messageStream: { holdMs: 5000, idleMs: 5000 },
        }),
      TypeError,
    );
    assert.throws(
      () =>
        createLocalAgentGateway({
          hostPolicy: policy,
          token: "t",
          messageStream: { coalesceMs: 2000, holdMs: 2000 },
        }),
      TypeError,
    );
  } finally {
    never.resolve();
    await harness.close();
  }
});

test("a streamed turn refuses every check exactly as the buffered turn", async () => {
  let presentation = 0;
  let inference = true;
  let paidRefusal = false;
  const paidPaths = [];
  const presentationGate = { wait: null };
  const harness = await streamHarness({
    hostPolicy: {
      ...policy,
      isPaidAction: (_method, path) => {
        paidPaths.push(path);
        return path.endsWith("/messages");
      },
      prepareMessage: (input) => ({
        body: { text: input.text },
        chatTask: { id: "task" },
      }),
    },
    inferenceConfigured: async () => inference,
    cloudHandler: Object.assign(
      async (_req, res, url, { json }) => {
        if (url.pathname !== "/identity/logout") return false;
        json(res, 200, { disconnected: true });
        return true;
      },
      {
        requirePaidAccess: async () => {
          if (paidRefusal)
            throw Object.assign(new Error("Paid access required"), {
              status: 402,
            });
        },
      },
    ),
    taskGateway: {
      revoke: async () => {},
      presentationForConversation: async () => {
        await presentationGate.wait?.();
        return { choice: { id: "choice", version: presentation++ } };
      },
    },
  });
  const { state } = harness;
  // `atReply`: the check runs on the final reply, after text may have been
  // pulled; the renderer then discards that text, as for any failed pull.
  const same = async (name, arrange, expected, atReply = false) => {
    const results = [];
    for (const run of [harness.buffered, harness.streamed]) {
      const restore = await arrange();
      const { status, body, events = [] } = await run();
      restore?.();
      results.push({ status, body });
      if (!atReply) assert.deepEqual(events, [], name);
    }
    assert.deepEqual(results[1], results[0], name);
    assert.equal(results[0].status, expected, name);
  };
  try {
    await same("room not created", () => {}, 409);
    assert.equal(state.requests.length, 0);
    assert.equal((await harness.post("/conversations")).status, 200);
    await same(
      "inference unavailable",
      () => {
        inference = false;
        return () => (inference = true);
      },
      503,
    );
    paidPaths.length = 0;
    await same(
      "paid access",
      () => {
        paidRefusal = true;
        return () => (paidRefusal = false);
      },
      402,
    );
    assert.deepEqual(paidPaths, [
      `/conversations/${id}/messages`,
      `/conversations/${id}/messages`,
    ]);
    await same(
      "stale account",
      () => {
        state.owner = Object.assign(
          new Error("Runtime account binding changed"),
          {
            status: 409,
          },
        );
        return () => (state.owner = "a");
      },
      409,
    );
    const turns = () =>
      state.requests.filter(({ url }) => url.includes("/messages")).length;
    const sent = turns();
    await same(
      "reset during admission",
      async () => {
        assert.equal((await harness.post("/conversations")).status, 200);
        presentationGate.wait = async () => {
          presentationGate.wait = null;
          assert.equal((await harness.post("/identity/logout")).status, 200);
        };
        return async () => {};
      },
      409,
    );
    assert.equal(turns(), sent);
    assert.equal((await harness.post("/conversations")).status, 200);
    await same(
      "agent refusal",
      () => {
        state.status = 404;
        return () => (state.status = 200);
      },
      404,
    );
    await same(
      "ephemeral reply",
      () => {
        state.reply = { ...agentReply, assistantEphemeral: true };
        return () => (state.reply = agentReply);
      },
      503,
      true,
    );
    // The task presentation changes between admission and the reply.
    await same("task presentation changed", () => {}, 409, true);
    await same(
      "account rotated during the turn",
      () => {
        state.onTurn = async () => {
          state.owner = "b";
        };
        return () => {
          state.onTurn = async () => {};
          state.owner = "a";
        };
      },
      409,
    );
  } finally {
    await harness.close();
  }
});

test("account rotation and reset end a stream without its remaining text", async () => {
  const harness = await streamHarness();
  const { state, start, pull } = harness;
  let gate = Promise.withResolvers();
  try {
    for (const transition of ["rotate", "reset"]) {
      gate = Promise.withResolvers();
      state.owner = "a";
      assert.equal((await harness.post("/conversations")).status, 200);
      state.beforeFrame = (index) => (index === 1 ? gate.promise : undefined);
      const { streamId } = (await start()).body;
      assert.equal((await pull(streamId, 0)).body.cursor, 1);
      const held = pull(streamId, 1);
      if (transition === "rotate") state.owner = "b";
      else assert.equal((await harness.post("/identity/logout")).status, 200);
      gate.resolve();
      const refused = await held;
      assert.deepEqual(refused, {
        status: 409,
        body: {
          error: "Gateway request failed (error5)",
          code: "CONVERSATION_NOT_OWNED",
        },
      });
      await state.closed.at(-1);
      state.owner = "a";
      assert.equal((await pull(streamId, 1)).status, 404);
    }
  } finally {
    gate.resolve();
    await harness.close();
  }
});

test("a pull collects text to a phrase, one pull waits per stream, one account check per pull", async () => {
  const harness = await streamHarness({
    messageStream: { coalesceMs: 400, holdMs: 1500 },
  });
  const { state, start, pull, cancel } = harness;
  const gates = [0, 1, 2, 3, 4].map(() => Promise.withResolvers());
  try {
    assert.equal((await harness.post("/conversations")).status, 200);
    // A burst and its done frame come back in one pull, without the hold.
    let before = Date.now();
    const burst = await harness.streamed();
    assert.ok(Date.now() - before < 1000);
    assert.deepEqual(
      burst.events.map(({ seq }) => seq),
      [1, 2, 3, 4],
    );
    assert.equal(burst.pulls, 1);
    // Text that ends a phrase answers before the collection window ends.
    state.tokens = ["Hi", " there.", " More"];
    state.beforeFrame = (index) => gates[index].promise;
    const { streamId } = (await start()).body;
    const phrase = pull(streamId, 0);
    gates[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    before = Date.now();
    gates[1].resolve();
    assert.deepEqual((await phrase).body.events, [
      { seq: 1, text: "Hi" },
      { seq: 2, text: " there." },
    ]);
    assert.ok(Date.now() - before < 300);
    // A second waiting pull answers the first one at once.
    const older = pull(streamId, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    before = Date.now();
    const newer = pull(streamId, 2);
    assert.deepEqual((await older).body, {
      events: [],
      cursor: 2,
      done: false,
    });
    assert.ok(Date.now() - before < 300);
    const settled = await Promise.race([
      newer.then(() => "answered"),
      new Promise((resolve) => setTimeout(resolve, 100, "waiting")),
    ]);
    assert.equal(settled, "waiting");
    gates[2].resolve();
    assert.deepEqual((await newer).body.events, [{ seq: 3, text: " More" }]);
    // Each pull checks the account once.
    const calls = state.gateCalls;
    let pulls = 0;
    let cursor = 3;
    gates[3].resolve();
    for (;;) {
      const { body } = await pull(streamId, cursor);
      pulls++;
      cursor = body.cursor;
      if (body.done) break;
    }
    // One check per pull and one for the final reply.
    assert.equal(state.gateCalls - calls, pulls + 1);
    assert.equal((await cancel(streamId)).status, 200);
    assert.equal(state.gateCalls - calls, pulls + 1);
  } finally {
    for (const gate of gates) gate.resolve();
    await harness.close();
  }
});

test("agent failures after the stream opens become 502, unlike the buffered status", async () => {
  const harness = await streamHarness();
  const { state } = harness;
  try {
    assert.equal((await harness.post("/conversations")).status, 200);
    state.terminal = {
      type: "error",
      message: "Idempotency key reused",
      code: "IDEMPOTENCY_CONFLICT",
    };
    const conflict = await harness.streamed();
    assert.equal(conflict.status, 502);
    assert.deepEqual(conflict.body, {
      error: "Idempotency key reused",
      code: "IDEMPOTENCY_CONFLICT",
    });
    state.terminal = { type: "error" };
    assert.deepEqual((await harness.streamed()).body, {
      error: "Local agent unavailable",
    });
    // A stream that ends without its done frame has no reply.
    state.terminal = "none";
    assert.deepEqual(
      await harness.streamed().then(({ status, body }) => ({ status, body })),
      {
        status: 502,
        body: { error: "Local agent unavailable" },
      },
    );
  } finally {
    await harness.close();
  }
});

test("sign-out stops a streamed turn like a buffered one, and never an answered turn", async () => {
  const harness = await streamHarness();
  const { state, start, pull, cancel } = harness;
  const never = Promise.withResolvers();
  const aborts = () =>
    state.requests.filter((request) => request.url.startsWith("/api/turns/"));
  const until = async (check) => {
    for (let i = 0; i < 200 && !check(); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  const signOut = async () => {
    assert.equal((await harness.post("/identity/logout")).status, 200);
    assert.equal((await harness.post("/conversations")).status, 200);
  };
  try {
    assert.equal((await harness.post("/conversations")).status, 200);
    // An answered turn, buffered or streamed to its end, has nothing to stop.
    assert.equal((await harness.buffered()).status, 200);
    await signOut();
    assert.equal((await harness.streamed()).status, 200);
    await signOut();
    // A sign-out during a streamed reply aborts it here and stops its turn.
    state.beforeFrame = (index) => (index === 1 ? never.promise : undefined);
    const { streamId } = (await start()).body;
    assert.equal((await pull(streamId, 0)).body.cursor, 1);
    await signOut();
    await state.closed.at(-1);
    await until(() => aborts().length === 1);
    // Its text never reaches the next account.
    assert.equal((await pull(streamId, 1)).body.code, "CONVERSATION_NOT_OWNED");
    assert.equal((await pull(streamId, 1)).status, 404);
    // A cancelled stream may still run upstream, like a closed buffered
    // request, so the next sign-out still stops its turn.
    const cancelled = (await start()).body.streamId;
    assert.equal((await pull(cancelled, 0)).body.cursor, 1);
    assert.equal((await cancel(cancelled)).status, 200);
    await state.closed.at(-1);
    await signOut();
    await until(() => aborts().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(aborts(), [
      { url: `/api/turns/${id}/abort`, body: { reason: "cloud-logout" } },
      { url: `/api/turns/${id}/abort`, body: { reason: "cloud-logout" } },
    ]);
  } finally {
    never.resolve();
    await harness.close();
  }
});
