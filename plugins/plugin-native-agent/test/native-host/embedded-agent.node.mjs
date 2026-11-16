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
    res.writeHead(200, {"Content-Type":"text/event-stream"});
    if (text === "refused") return res.end('data: {"type":"done","fullText":"Sorry","failureKind":"provider_issue"}\\n\\n');
    if (text === "cut") return res.write('data: {"text":"H');
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
  const post = (route, body, headers = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { settled, post, seen, base };
}

test("the development agent runs from the data files and serves only their routes", async (t) => {
  let key = "cloud-key";
  const { settled, post, base } = await development(t, {
    credential: async () => key,
  });
  await settled("running");
  const turn = { method: "POST", path: stream, body: { text: "hello" } };
  const sent = (method, route, headers) =>
    new Promise((resolve, reject) =>
      http
        .request(base + route, { method, headers }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject)
        .end(method === "POST" ? JSON.stringify(turn) : undefined),
    );
  for (const headers of [
    { "Content-Type": "text/plain" },
    {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    },
    { "Content-Type": "application/json", "Sec-Fetch-Site": "same-site" },
    { "Content-Type": "application/json", Host: "evil.example" },
  ])
    assert.equal(await sent("POST", "/stream", headers), 403);
  assert.equal(await sent("GET", "/status", { Host: "evil.example" }), 403);
  assert.equal(
    (
      await post("/stream", turn, {
        Origin: new URL(base).origin,
        "Sec-Fetch-Site": "same-origin",
      })
    ).status,
    200,
  );
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
  const reply = await post("/stream", turn);
  assert.equal(await reply.text(), 'data: {"text":"Hi"}\n\ndata: [DONE]\n\n');
  const refused = await post("/stream", {
    ...turn,
    body: { text: "refused" },
  });
  assert.equal(refused.status, 200);
  assert.equal(
    await refused.text(),
    'data: {"type":"done","fullText":"Sorry","failureKind":"provider_issue"}\n\n',
  );
  const cut = (
    await post("/stream", { ...turn, body: { text: "cut" } })
  ).body.getReader();
  assert.equal(
    new TextDecoder().decode((await cut.read()).value),
    'data: {"text":"H',
  );
  await post("/stream", { ...turn, body: { text: "crash" } }).catch(() => {});
  await assert.rejects(async () => {
    while (!(await cut.read()).done);
  });
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
