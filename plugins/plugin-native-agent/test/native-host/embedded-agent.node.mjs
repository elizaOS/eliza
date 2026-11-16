import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EMBEDDED_AGENT_PREFIX,
  embeddedAgentDevelopment,
  parseEmbeddedAgentData,
} from "../../native-host/embedded-agent.mjs";

const host = {
  schema: 1,
  service: "example.consumer.HelperService",
  notification: { channel: "Helper", title: "Helper", text: "Helper is ready" },
  cloud: { baseUrl: "https://cloud.example", largeModel: "large-1" },
  routes: [
    { method: "GET", path: "/api/status" },
    {
      method: "POST",
      path: "/api/conversations/{id}/messages/stream",
      stream: true,
    },
  ],
  environment: { ELIZA_PLUGIN_SET: "lean-chat" },
};
const character = { name: "Helper", system: "Answer briefly." };
const policy = {
  schema: 1,
  actions: { allowed: { REPLY: "talk" }, refused: { BROWSE: "page" } },
  plugins: { denied: ["@elizaos/plugin-browser"] },
};

const agent = `
const http = require("node:http");
const token = process.env.ELIZA_API_TOKEN;
http.createServer((req, res) => {
  if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); return res.end("{}"); }
  if (req.url === "/api/status") { res.writeHead(200, {"Content-Type":"application/json"}); return res.end(JSON.stringify({provider: process.env.ELIZA_PROVIDER, key: process.env.ELIZAOS_CLOUD_API_KEY === "cloud-key"})); }
  let body = ""; req.on("data", (c) => body += c); req.on("end", () => {
    if (JSON.parse(body).text === "crash") process.exit(3);
    res.writeHead(200, {"Content-Type":"text/event-stream"});
    res.end('data: {"text":"Hi"}\\n\\ndata: [DONE]\\n\\n');
  });
}).listen(Number(process.env.ELIZA_API_PORT), "127.0.0.1");
`;

test("the development agent runs from the data files and serves only their routes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embedded-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {};
  for (const [name, value] of Object.entries({ host, character, policy })) {
    files[name] = path.join(root, `${name}.json`);
    fs.writeFileSync(files[name], JSON.stringify(value));
  }
  fs.writeFileSync(path.join(root, "agent.cjs"), agent);
  let key = "cloud-key";
  const plugin = embeddedAgentDevelopment({
    data: files,
    credential: async () => key,
    stateDirectory: path.join(root, "state"),
    command: {
      executable: process.execPath,
      args: [path.join(root, "agent.cjs")],
      cwd: root,
    },
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
  const post = (route, body) =>
    fetch(base + route, { method: "POST", body: JSON.stringify(body) });
  const state = async (expected) => {
    for (let i = 0; i < 400; i++) {
      const status = await (await fetch(`${base}/status`)).json();
      if (status.state === expected) return status;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`never ${expected}`);
  };

  await state("running");
  assert.deepEqual(
    await (
      await post("/request", { method: "GET", path: "/api/status" })
    ).json(),
    { status: 200, data: { provider: "elizacloud", key: true } },
  );
  for (const refused of [
    ["/request", { method: "GET", path: "/api/config" }],
    [
      "/request",
      { method: "POST", path: "/api/conversations/c1/messages/stream" },
    ],
    ["/stream", { method: "GET", path: "/api/status" }],
  ])
    assert.equal((await post(...refused)).status, 403);
  const stream = await post("/stream", {
    method: "POST",
    path: "/api/conversations/c1/messages/stream",
    body: { text: "hello" },
  });
  assert.equal(await stream.text(), 'data: {"text":"Hi"}\n\ndata: [DONE]\n\n');

  await post("/stream", {
    method: "POST",
    path: "/api/conversations/c1/messages/stream",
    body: { text: "crash" },
  }).catch(() => {});
  await state("starting");
  await state("running");

  key = null;
  await post("/restart", {});
  assert.equal((await state("failed")).failure, "credential");
  await post("/stop", {});
});

test("data the device service refuses is refused here too", () => {
  for (const changed of [
    { host: { ...host, environment: { ELIZAOS_CLOUD_API_KEY: "x" } } },
    { host: { ...host, cloud: { baseUrl: "http://cloud.example" } } },
    { host: { ...host, routes: [{ method: "GET", path: "/api/../x" }] } },
    { character: { name: "", system: "x" } },
    {
      policy: {
        ...policy,
        actions: { allowed: { REPLY: "" }, refused: { REPLY: "" } },
      },
    },
  ])
    assert.throws(() =>
      parseEmbeddedAgentData({ host, character, policy, ...changed }),
    );
  const data = parseEmbeddedAgentData({ host, character, policy });
  assert.equal(
    data.admit("POST", "/api/conversations/a/b/messages/stream"),
    null,
  );
  assert.equal(data.admit("GET", "/api/status?x=1"), null);
  assert.equal(data.agentEnvironment("k").ELIZA_ACTION_ALLOWLIST, '["REPLY"]');
});
