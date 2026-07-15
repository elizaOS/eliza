#!/usr/bin/env node
/**
 * Deterministic FAKE ACP coding agent — replays the "ideal" Claude-Code / Codex
 * ACP session for a given app-build scenario, with NO LLM. Speaks the same
 * newline-delimited JSON-RPC over stdio that NativeAcpClient drives:
 *   ← initialize            → { protocolVersion, agentCapabilities, agentInfo }
 *   ← session/new           → { sessionId }
 *   ← session/prompt        → (server emits session/update notifications +
 *                              fs/write_text_file REQUESTS the orchestrator
 *                              executes, then) { stopReason: "end_turn" }
 *
 * Scenario is chosen by FAKE_ACP_SCENARIO (default "random-color"). Because the
 * orchestrator performs the real fs writes, the workspace genuinely gets the
 * app files and the whole spawn→prompt→tool→complete→verify→done flow runs
 * deterministically for keyless e2e.
 */
import { createInterface } from "node:readline";

const SCENARIO = process.env.FAKE_ACP_SCENARIO || "random-color";
const PROTOCOL_VERSION = 1;

// Each scenario: the files the "agent" writes + the completion evidence it
// reports (a real diff + real-looking test-runner output, internally consistent
// — the shape the grilling verifier accepts).
const SCENARIOS = {
  "random-color": {
    plan: [
      "Create index.html",
      "Add the random-color script",
      "Verify it renders",
    ],
    files: [
      {
        path: "package.json",
        content: `{
  "name": "random-color-app",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}\n`,
      },
      {
        path: "index.html",
        content: `<!doctype html><html><head><meta charset="utf-8"><title>Random Color</title></head>
<body><button id="go">New color</button>
<script type="module" src="./app.js"></script></body></html>\n`,
      },
      {
        path: "app.js",
        // DOM wiring is guarded so the module is genuinely importable (and its
        // tests genuinely runnable) under plain Node — the e2e test executes
        // `node --test` against these files for real.
        content: `function randomColor(){return '#'+Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0');}
if (typeof document !== "undefined") {
  document.getElementById('go').addEventListener('click',()=>{document.body.style.background=randomColor();});
}
export { randomColor };\n`,
      },
      {
        path: "app.test.js",
        content: `import test from "node:test";
import assert from "node:assert/strict";
import { randomColor } from "./app.js";
test("returns a #rrggbb hex string", () => { assert.match(randomColor(), /^#[0-9a-f]{6}$/); });
test("is well-formed across repeated calls", () => { for (let i=0;i<5;i++) assert.match(randomColor(), /^#[0-9a-f]{6}$/); });\n`,
      },
    ],
    completion: `Done — built a random-color web app.

\`\`\`diff
diff --git a/index.html b/index.html
new file mode 100644
diff --git a/app.js b/app.js
new file mode 100644
diff --git a/app.test.js b/app.test.js
new file mode 100644
\`\`\`

\`\`\`
$ npm test

# tests 2
# suites 0
# pass 2
# fail 0
\`\`\`
`,
  },
  "todo-list": {
    plan: ["Create the todo model", "Add add/remove", "Test it"],
    files: [
      {
        path: "todo.js",
        content: `export function createTodos(){const items=[];return{add:t=>{items.push({t,done:false});return items.length;},remove:i=>items.splice(i,1),all:()=>items.slice()};}\n`,
      },
      {
        path: "todo.test.js",
        content: `import { describe, it, expect } from "vitest";
import { createTodos } from "./todo.js";
describe("todos", () => {
  it("adds and lists", () => { const t=createTodos(); t.add("a"); t.add("b"); expect(t.all().length).toBe(2); });
  it("removes", () => { const t=createTodos(); t.add("a"); t.remove(0); expect(t.all().length).toBe(0); });
  it("marks shape", () => { const t=createTodos(); t.add("x"); expect(t.all()[0]).toEqual({t:"x",done:false}); });
});\n`,
      },
    ],
    completion: `Done — implemented an in-memory todo list.

\`\`\`diff
diff --git a/todo.js b/todo.js
new file mode 100644
diff --git a/todo.test.js b/todo.test.js
new file mode 100644
\`\`\`

\`\`\`
$ npm test
 Test Files  1 passed (1)
      Tests  3 passed (3)
\`\`\`
`,
  },
};

const scenario = SCENARIOS[SCENARIO] ?? SCENARIOS["random-color"];

const out = process.stdout;
function send(obj) {
  out.write(`${JSON.stringify(obj)}\n`);
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function update(sessionId, update) {
  notify("session/update", { sessionId, update });
}

// Outgoing REQUESTS to the client (fs/write_text_file) need a reply; track them.
let nextReqId = 1;
const pendingClientReplies = new Map();
function requestClient(method, params) {
  const id = `fa-${nextReqId++}`;
  return new Promise((resolve) => {
    pendingClientReplies.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let sessionCounter = 0;

async function handlePrompt(sessionId) {
  update(sessionId, { sessionUpdate: "session_started" });
  update(sessionId, {
    sessionUpdate: "plan",
    entries: scenario.plan.map((content, i) => ({
      content,
      status: i === 0 ? "in_progress" : "pending",
      priority: "medium",
    })),
  });
  for (const file of scenario.files) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCall: {
        title: `Write ${file.path}`,
        kind: "edit",
        status: "in_progress",
      },
    });
    // The orchestrator performs the real write into the workspace.
    await requestClient("fs/write_text_file", {
      sessionId,
      path: file.path,
      content: file.content,
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCall: {
        title: `Write ${file.path}`,
        kind: "edit",
        status: "completed",
      },
    });
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: scenario.completion },
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  // A reply to one of our fs/write_text_file requests.
  if (
    msg.id !== undefined &&
    (msg.result !== undefined || msg.error !== undefined) &&
    pendingClientReplies.has(msg.id)
  ) {
    const resolve = pendingClientReplies.get(msg.id);
    pendingClientReplies.delete(msg.id);
    resolve(msg.result);
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: { image: false } },
        agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      },
    });
  } else if (method === "session/new") {
    const sessionId = `fake-session-${++sessionCounter}`;
    send({ jsonrpc: "2.0", id, result: { sessionId } });
  } else if (method === "session/prompt") {
    const sessionId = params?.sessionId ?? `fake-session-${sessionCounter}`;
    await handlePrompt(sessionId);
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else if (method === "session/cancel" || method === "session/close") {
    if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined) {
    // Unknown request: reply empty so the client doesn't hang.
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
