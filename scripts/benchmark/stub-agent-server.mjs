#!/usr/bin/env node
/**
 * stub-agent-server.mjs — minimal in-process HTTP stub that mimics the
 * agent surface profile-inference.mjs talks to. Exists ONLY to validate
 * the harness end-to-end without standing up a real elizaOS instance.
 *
 * Implemented endpoints:
 *   GET    /api/health
 *   POST   /api/local-inference/active   { modelId } -> ActiveModelState
 *   DELETE /api/local-inference/active   -> ActiveModelState
 *   POST   /api/conversations            { title? } -> { conversation }
 *   DELETE /api/conversations/:id
 *   POST   /api/conversations/:id/messages          (sync)
 *   POST   /api/conversations/:id/messages/stream   (SSE)
 *
 * Usage:
 *   node scripts/benchmark/stub-agent-server.mjs [--port 31337]
 */

import http from "node:http";
import process from "node:process";

function parseArgs(argv) {
  const out = { port: 31337 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") {
      out.port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const conversations = new Map();
let activeModel = null;

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function syntheticReply(prompt) {
  // Deterministic synthetic reply length scaled to prompt for realism.
  const len = Math.max(20, Math.min(prompt.length, 300));
  return `[stub reply] echo of ${prompt.length}-char prompt: ${prompt.slice(0, 40)}... (${len} synthetic chars)`;
}

const args = parseArgs(process.argv.slice(2));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.pathname;

    if (method === "GET" && pathname === "/api/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (method === "POST" && pathname === "/api/local-inference/active") {
      const body = await readJson(req);
      const modelId = body?.modelId;
      if (typeof modelId !== "string") {
        return sendJson(res, 400, { error: "modelId required" });
      }
      // Simulate variable model load times.
      await sleep(modelId.includes("8b") ? 350 : 120);
      activeModel = {
        modelId,
        loadedAt: new Date().toISOString(),
        status: "ready",
      };
      return sendJson(res, 200, activeModel);
    }

    if (method === "DELETE" && pathname === "/api/local-inference/active") {
      activeModel = null;
      return sendJson(res, 200, {
        modelId: null,
        loadedAt: null,
        status: "idle",
      });
    }

    if (method === "POST" && pathname === "/api/conversations") {
      const body = await readJson(req);
      const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const conversation = {
        id,
        title: typeof body?.title === "string" ? body.title : "New Chat",
        roomId: `room-${id}`,
        createdAt: now,
        updatedAt: now,
      };
      conversations.set(id, conversation);
      return sendJson(res, 200, { conversation });
    }

    {
      const m = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
      if (m && method === "DELETE") {
        conversations.delete(m[1]);
        return sendJson(res, 200, { deleted: true });
      }
    }

    {
      const m = /^\/api\/conversations\/([^/]+)\/messages$/.exec(pathname);
      if (m && method === "POST") {
        if (!conversations.has(m[1])) {
          return sendJson(res, 404, { error: "Conversation not found" });
        }
        if (!activeModel) {
          return sendJson(res, 503, { error: "No active model" });
        }
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text : "";
        // Simulate sync inference roughly proportional to prompt length.
        await sleep(Math.min(800, 80 + text.length / 2));
        return sendJson(res, 200, {
          text: syntheticReply(text),
          agentName: "StubBot",
        });
      }
    }

    {
      const m = /^\/api\/conversations\/([^/]+)\/messages\/stream$/.exec(
        pathname,
      );
      if (m && method === "POST") {
        if (!conversations.has(m[1])) {
          return sendJson(res, 404, { error: "Conversation not found" });
        }
        if (!activeModel) {
          return sendJson(res, 503, { error: "No active model" });
        }
        const body = await readJson(req);
        const text = typeof body?.text === "string" ? body.text : "";
        const reply = syntheticReply(text);
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        // Simulate first-token latency.
        await sleep(60 + Math.random() * 40);
        const chunks = reply.match(/.{1,8}/g) ?? [reply];
        for (const chunk of chunks) {
          res.write(
            `data: ${JSON.stringify({ type: "token", text: chunk })}\n\n`,
          );
          await sleep(8);
        }
        res.write(
          `data: ${JSON.stringify({ type: "done", fullText: reply, agentName: "StubBot" })}\n\n`,
        );
        return res.end();
      }
    }

    sendJson(res, 404, { error: `No stub handler for ${method} ${pathname}` });
  } catch (err) {
    sendJson(res, 500, { error: err.message ?? String(err) });
  }
});

server.listen(args.port, "127.0.0.1", () => {
  process.stdout.write(
    `[stub-agent-server] listening on 127.0.0.1:${args.port}\n`,
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
