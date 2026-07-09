#!/usr/bin/env node
// Drives end-to-end coverage for the Code example.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
/**
 * Record/replay proxy for an OpenAI-compatible LLM provider, so the REAL coding
 * agent can be driven by "ideal" recorded responses (a theoretical codex/claude/
 * gemma session) with NO live LLM — deterministic e2e.
 *
 *   MODE=record  LLM_UPSTREAM=https://api.cerebras.ai/v1  LLM_KEY=csk-...  \
 *   LLM_RECORDING=/tmp/session.json  PORT=8899  node llm-proxy.mjs
 *   MODE=replay  LLM_RECORDING=/tmp/session.json  PORT=8899  node llm-proxy.mjs
 *
 * Point the agent at http://127.0.0.1:$PORT/v1 (OPENAI_BASE_URL).
 */
import { createServer } from "node:http";

const MODE = process.env.MODE || "replay";
const UPSTREAM = process.env.LLM_UPSTREAM || "https://api.cerebras.ai/v1";
const KEY = process.env.LLM_KEY || "";
const RECORDING = process.env.LLM_RECORDING || "/tmp/llm-session.json";
const PORT = Number(process.env.PORT || 8899);
const REPLAY_WORKDIR = process.env.LLM_REPLAY_WORKDIR || "";

/** Normalize volatile tokens so the same LOGICAL request matches regardless of
 *  run context (temp workdir paths, UUIDs, session ids, timestamps) — otherwise
 *  a replay in a fresh workdir diverges from the recording and misses. */
function normalizeVolatile(text) {
  return text
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s"'`)\]]+/g, "<PATH>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<UUID>",
    )
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "<TS>")
    .replace(/\b\d{10,13}\b/g, "<TS>");
}

/** Stable key for a chat request: the model + the messages (role+content) with
 *  volatile tokens normalized out. */
function reqKey(body) {
  const msgs = (body.messages || []).map((m) => ({
    role: m.role,
    content: normalizeVolatile(
      typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    ),
  }));
  return createHash("sha256")
    .update(
      JSON.stringify({ model: body.model, msgs, tools: body.tools ?? null }),
    )
    .digest("hex");
}

function escapeReplacement(value) {
  return value.replace(/\$/g, "$$$$");
}

function rewriteRecordedWorkspacePaths(hit) {
  if (!REPLAY_WORKDIR) return hit;
  const raw = Buffer.from(hit.bodyB64, "base64").toString("utf8");
  const rewritten = raw.replace(
    /(?:\/private)?\/var\/folders\/[^"'\s]+\/T\/eliza-det-replay-workspace/g,
    escapeReplacement(REPLAY_WORKDIR),
  );
  return { ...hit, bodyB64: Buffer.from(rewritten).toString("base64") };
}

let recorded = [];
const byKey = new Map();
if (MODE === "replay") {
  if (!existsSync(RECORDING)) {
    console.error(`[llm-proxy] recording not found: ${RECORDING}`);
    process.exit(2);
  }
  recorded = JSON.parse(readFileSync(RECORDING, "utf8"));
  for (const r of recorded) byKey.set(r.key, r.rec ?? r.response);
  console.error(`[llm-proxy] replay: ${recorded.length} recorded turns`);
} else {
  console.error(`[llm-proxy] record → ${RECORDING} (upstream ${UPSTREAM})`);
}

let seq = 0;
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", async () => {
    if (!req.url.includes("/chat/completions")) {
      // Pass /models etc. through (record) or stub (replay).
      if (MODE === "record") {
        const up = await fetch(`${UPSTREAM}${req.url.replace(/^\/v1/, "")}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${KEY}` },
        }).catch(() => null);
        const txt = up ? await up.text() : "{}";
        res.writeHead(up?.status ?? 200, {
          "Content-Type": "application/json",
        });
        return res.end(txt);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"object":"list","data":[{"id":"gemma-4-31b"}]}');
    }
    let body;
    try {
      body = JSON.parse(data);
    } catch {
      res.writeHead(400);
      return res.end("bad json");
    }
    const key = reqKey(body);
    if (MODE === "replay") {
      const expected = recorded[seq];
      const keyed =
        expected?.key === key
          ? (expected.rec ?? expected.response)
          : byKey.get(key);
      const hit = keyed ?? expected?.rec ?? expected?.response;
      if (!keyed && hit) {
        console.error(
          `[llm-proxy] replay fallback turn ${seq + 1} key=${key.slice(0, 12)}`,
        );
      }
      seq += 1;
      if (!hit) {
        console.error(
          `[llm-proxy] replay MISS turn ${seq} key=${key.slice(0, 12)}`,
        );
        res.writeHead(500);
        return res.end('{"error":"no recorded response for this request"}');
      }
      const response = rewriteRecordedWorkspacePaths(hit);
      res.writeHead(response.status, { "Content-Type": response.contentType });
      return res.end(Buffer.from(response.bodyB64, "base64"));
    }
    // record: capture the RAW response (handles streaming SSE + JSON). Absorb
    // Cerebras TPM rate-limits (429) with backoff so the agent never sees them
    // and the recorded session is a clean, uninterrupted "ideal" run.
    let up;
    for (let attempt = 0; ; attempt++) {
      up = await fetch(`${UPSTREAM}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
        },
        body: data,
      });
      if (up.status !== 429 || attempt >= 8) break;
      const retryAfter = Number(up.headers.get("retry-after")) || 20;
      console.error(
        `[llm-proxy] 429 tpm-limit, waiting ${retryAfter}s (attempt ${attempt + 1}/8)`,
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
    const raw = Buffer.from(await up.arrayBuffer());
    const contentType = up.headers.get("content-type") || "application/json";
    const rec = {
      status: up.status,
      contentType,
      bodyB64: raw.toString("base64"),
    };
    recorded.push({ key, seq: seq++, rec });
    if (recorded.length % 1 === 0)
      writeFileSync(RECORDING, JSON.stringify(recorded));
    res.writeHead(up.status, { "Content-Type": contentType });
    res.end(raw);
  });
});
server.listen(PORT, "127.0.0.1", () =>
  console.error(`[llm-proxy] ${MODE} on http://127.0.0.1:${PORT}/v1`),
);
