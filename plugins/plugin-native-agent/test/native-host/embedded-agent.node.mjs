import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMBEDDED_AGENT_PREFIX,
  embeddedAgentDevelopment,
  parseEmbeddedAgentData,
} from "../../native-host/embedded-agent.mjs";

const source = fileURLToPath(new URL("../../../..", import.meta.url));
const { valid, refused } = JSON.parse(
  fs.readFileSync(
    new URL("../embedded/embedded-agent-data.json", import.meta.url),
  ),
);
const stream = "/api/conversations/c1/messages/stream";

const agent = `
const http = require("node:http");
const token = process.env.ELIZA_API_TOKEN;
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); return res.end("{}"); }
  if (req.url === "/api/status") { res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({provider: process.env.ELIZA_PROVIDER, key: process.env.ELIZAOS_CLOUD_API_KEY === "cloud-key"})); }
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    const { text } = JSON.parse(body);
    if (text === "crash") process.exit(3);
    if (text === "refused") { res.writeHead(401, {"Content-Type":"application/json"}); return res.end('{"error":"Invalid API key"}'); }
    res.writeHead(200, {"Content-Type":"text/event-stream"});
    res.end('data: {"text":"Hi"}\\n\\ndata: [DONE]\\n\\n');
  });
}).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
`;

async function development(t, { script, executable, credential }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {};
  for (const [name, value] of Object.entries(valid)) {
    files[name] = path.join(root, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(value));
  }
  fs.writeFileSync(path.join(root, "agent.cjs"), script ?? agent);
  const plugin = embeddedAgentDevelopment({
    source,
    data: files,
    credential,
    stateDirectory: path.join(root, "state"),
    command: {
      executable: executable ?? process.execPath,
      args: [path.join(root, "agent.cjs")],
      cwd: root,
    },
    readyMs: 5000,
    restartDelayMs: 10,
  });
  const routes = [];
  const server = http.createServer((req, res) => {
    const [prefix, handle] = routes.find(([p]) => req.url.startsWith(p));
    req.url = req.url.slice(prefix.length);
    handle(req, res);
  });
  plugin.configureServer({
    middlewares: { use: (prefix, handle) => routes.push([prefix, handle]) },
    httpServer: server,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}${EMBEDDED_AGENT_PREFIX}`;
  const seen = [];
  const settled = async (...expected) => {
    for (let i = 0; i < 400; i++) {
      const status = await (await fetch(`${base}/status`)).json();
      if (seen.at(-1) !== status.state) seen.push(status.state);
      if (expected.includes(status.state)) return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`never ${expected}`);
  };
  const post = (route, body) =>
    fetch(base + route, { method: "POST", body: JSON.stringify(body) });
  return { settled, post, seen };
}

test("the development agent runs from the data files and serves only their routes", async (t) => {
  let key = "cloud-key";
  const { settled, post } = await development(t, {
    credential: async () => key,
  });
  await settled("running");
  assert.deepEqual(
    await (
      await post("/request", { method: "GET", path: "/api/status" })
    ).json(),
    { status: 200, data: { provider: "elizacloud", key: true } },
  );
  for (const refusal of [
    ["/request", { method: "GET", path: "/api/config" }],
    ["/request", { method: "POST", path: stream }],
    ["/stream", { method: "GET", path: "/api/status" }],
  ])
    assert.equal((await post(...refusal)).status, 403);
  const reply = await post("/stream", {
    method: "POST",
    path: stream,
    body: { text: "hello" },
  });
  assert.equal(await reply.text(), 'data: {"text":"Hi"}\n\ndata: [DONE]\n\n');
  assert.deepEqual(
    await (
      await post("/stream", {
        method: "POST",
        path: stream,
        body: { text: "refused" },
      })
    ).json(),
    { status: 401, data: { error: "Invalid API key" } },
  );

  await post("/stream", {
    method: "POST",
    path: stream,
    body: { text: "crash" },
  }).catch(() => {});
  await settled("starting");
  await settled("running");

  await post("/stop", {});
  assert.equal(
    (await post("/request", { method: "GET", path: "/api/config" })).status,
    403,
  );
  assert.equal(
    (await post("/request", { method: "GET", path: "/api/status" })).status,
    503,
  );
  key = "two words";
  await post("/restart", {});
  assert.equal((await settled("failed")).failure, "credential");
  key = null;
  await post("/restart", {});
  assert.equal((await settled("failed")).failure, "credential");
});

test("a development agent that cannot start fails with agent, without a restart", async (t) => {
  const missing = await development(t, {
    executable: path.join(os.tmpdir(), "no-such-agent-executable"),
    credential: async () => "cloud-key",
  });
  assert.equal((await missing.settled("failed")).failure, "agent");
  const exiting = await development(t, {
    script: "process.exit(1);",
    credential: async () => "cloud-key",
  });
  assert.equal((await exiting.settled("failed")).failure, "agent");
  assert.ok(!exiting.seen.includes("running"));
});

test("data the device service refuses is refused here too", () => {
  for (const changed of refused)
    assert.throws(() =>
      parseEmbeddedAgentData(
        Object.fromEntries(
          Object.entries(valid).map(([file, value]) => [
            file,
            { ...value, ...changed[file] },
          ]),
        ),
      ),
    );
  const data = parseEmbeddedAgentData(valid);
  assert.equal(
    data.admit("POST", "/api/conversations/a/b/messages/stream"),
    null,
  );
  assert.equal(data.admit("GET", "/api/status?x=1"), null);
  assert.equal(
    data.agentEnvironment("k").ELIZA_ACTION_ALLOWLIST,
    '["NONE","REPLY"]',
  );
});
