import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalCredentialStore } from "../../../plugins/plugin-native-agent/native-host/local-credential-client.mjs";
import { createCredentialGate } from "../../agent/native-host/gateway.mjs";
import { startLocalGateway } from "./gateway-bootstrap.mjs";

const fingerprint = (key) => createHash("sha256").update(key).digest("hex");
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function fixture(t, native) {
  const root = await mkdtemp(join(tmpdir(), "gateway-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const config = { native, root, port, upstream: "http://127.0.0.1:12837" };
  for (const key of [
    "tokenPath",
    "inboundTokenPath",
    "credentialPath",
    "bindingPath",
    "ownershipPath",
    "databasePath",
    "bundlePath",
  ])
    config[key] = join(root, key);
  await writeFile(config.tokenPath, "upstream-fixture-token\n");
  await writeFile(config.inboundTokenPath, "i".repeat(32));
  await writeFile(config.credentialPath, "fixture-account");
  await writeFile(
    config.bindingPath,
    JSON.stringify({
      mode: "cloud",
      fingerprint: fingerprint("fixture-account"),
      pid: process.pid,
      inferenceConfigured: true,
    }),
  );
  let brokerRequests = 0;
  if (native) {
    const broker = createServer(async (request, response) => {
      brokerRequests++;
      assert.equal(request.headers.authorization, `Bearer ${"b".repeat(32)}`);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          value: await readFile(config.credentialPath, "utf8"),
        }),
      );
    });
    config.credentialBroker = {
      port: await listen(broker),
      token: "b".repeat(32),
      timeoutMs: 2000,
    };
    t.after(() => new Promise((resolve) => broker.close(resolve)));
  }
  const events = [];
  let serverOptions;
  const ports = {
    createLocalCredentialStore,
    createFileCredentialStore: (file) => ({
      read: () => readFile(file, "utf8"),
    }),
    createCredentialGate: (options) =>
      createCredentialGate({
        ...options,
        localMode: "local",
        localOwner: "local:fixture",
      }),
    buildTaskRuntime: async (file) => {
      events.push("build");
      await writeFile(file, "built");
    },
    createCloudRoutes: (options) => options,
    createHelper: async ({ credentialGate }) => {
      await credentialGate();
      return {
        close() {
          events.push("helper closed");
        },
      };
    },
    createTaskGateway: async ({ databasePath, credentialGate }) => {
      await credentialGate();
      await writeFile(databasePath, "started");
      return {
        close() {
          events.push("tasks closed");
        },
      };
    },
    createServer: (options) => {
      serverOptions = options;
      return createServer(async (_request, response) => {
        try {
          const owner = await options.credentialGate();
          const configured = await options.inferenceConfigured?.();
          response.end(JSON.stringify({ owner, configured }));
        } catch {
          response.writeHead(409);
          response.end("changed");
        }
      });
    },
  };
  return {
    config,
    ports,
    events,
    get serverOptions() {
      return serverOptions;
    },
    get brokerRequests() {
      return brokerRequests;
    },
  };
}

for (const native of [false, true]) {
  test(`${native ? "native broker" : "desktop file"} bootstrap preserves account binding over real HTTP`, async (t) => {
    const f = await fixture(t, native);
    const gateway = await startLocalGateway({
      configuration: f.config,
      ports: f.ports,
    });
    t.after(() => gateway.close());
    const url = `http://127.0.0.1:${f.config.port}`;
    assert.deepEqual(await (await fetch(url)).json(), {
      owner: `cloud:${fingerprint("fixture-account")}`,
      ...(native ? { configured: true } : {}),
    });
    assert.equal(f.serverOptions.token, "upstream-fixture-token");
    assert.equal(
      f.serverOptions.inboundToken,
      native ? "i".repeat(32) : undefined,
    );
    assert.deepEqual(f.events, native ? [] : ["build"]);
    await writeFile(f.config.credentialPath, "changed-account");
    assert.equal((await fetch(url)).status, 409);
    assert.equal(f.brokerRequests > 0, native);
    await gateway.close();
    assert.deepEqual(f.events.slice(-2), ["tasks closed", "helper closed"]);
  });
}

test("native admission refuses weak token, invalid broker and relative state before helper startup", async (t) => {
  const f = await fixture(t, true);
  await writeFile(f.config.inboundTokenPath, "short");
  await assert.rejects(
    startLocalGateway({ configuration: f.config, ports: f.ports }),
    /token missing/,
  );
  await writeFile(f.config.inboundTokenPath, "i".repeat(32));
  await assert.rejects(
    startLocalGateway({
      configuration: { ...f.config, credentialBroker: { port: 12 } },
      ports: f.ports,
    }),
    /broker unavailable/,
  );
  await assert.rejects(
    startLocalGateway({
      configuration: { ...f.config, root: "relative" },
      ports: f.ports,
    }),
    /absolute path/,
  );
  assert.deepEqual(f.events, []);
  assert.equal(f.brokerRequests, 0);
});

test("missing or malformed binding fails closed without creating task state", async (t) => {
  const f = await fixture(t, false);
  await rm(f.config.bindingPath);
  await assert.rejects(
    startLocalGateway({ configuration: f.config, ports: f.ports }),
    /binding changed/,
  );
  await writeFile(f.config.bindingPath, "{");
  await assert.rejects(
    startLocalGateway({ configuration: f.config, ports: f.ports }),
    SyntaxError,
  );
  await assert.rejects(readFile(f.config.databasePath), { code: "ENOENT" });
});
