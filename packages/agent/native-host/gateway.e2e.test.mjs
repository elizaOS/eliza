import assert from "node:assert/strict";
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

test("allowlisted renderer preflight is answered before bearer authentication", async () => {
  const gateway = createLocalAgentGateway({
    hostPolicy: policy,
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
