/**
 * Wake-status readiness-signal probe (develop tip).
 *
 * Spawns the real server lane (`bun run packages/app-core/dist/entry.js start`
 * — the exact process the desktop launcher and cloud container run), then
 * concurrently:
 *   - polls GET /api/health   (the desktop launcher's boot gate: `ready`)
 *   - polls GET /api/status   (the app shell's readiness poll: `canRespond`,
 *                              via deriveAgentReady — the "Waking…" banner gate)
 *   - drives a REAL chat send (POST /api/conversations + /messages) from the
 *     first moment HTTP accepts, recording when the FIRST assistant reply lands.
 *
 * Output: a timeline proving when TRUE readiness (chat answered) happens vs
 * when each polled signal flips.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.PROBE_ROOT ?? ".";
const DIR = process.cwd();
const API_PORT = Number(process.env.PROBE_API_PORT ?? 31881);
const BASE = `http://127.0.0.1:${API_PORT}`;
const TOKEN = "wakeprobe-token";
const STATE_DIR = path.join(DIR, `state-${Date.now()}`);
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 240_000);
const DEFER = process.env.PROBE_DEFER ?? "1";

fs.mkdirSync(STATE_DIR, { recursive: true });
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}s`;
const events = [];
const mark = (name, detail = "") => {
  events.push({ t: Date.now() - t0, name, detail });
  console.log(`[probe] ${el()}  ${name}${detail ? `  ${detail}` : ""}`);
};

const child = spawn(
  "bun",
  ["run", "packages/app-core/dist/entry.js", "start"],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      ELIZA_HEADLESS: "1",
      ELIZA_API_PORT: String(API_PORT),
      ELIZA_DEFER_APP_ROUTES: DEFER,
      ELIZA_STATE_DIR: STATE_DIR,
      ELIZA_API_TOKEN: TOKEN,
      OPENAI_API_KEY: "sk-wakeprobe-mock-000000000000",
      OPENAI_BASE_URL: "http://127.0.0.1:18099/v1",
      OPENAI_SMALL_MODEL: "gpt-4o-mini",
      OPENAI_LARGE_MODEL: "gpt-4o",
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const logPath = path.join(DIR, "agent-boot.log");
const logStream = fs.createWriteStream(logPath);
child.stdout.on("data", (d) => logStream.write(d));
child.stderr.on("data", (d) => logStream.write(d));
child.on("exit", (code, sig) => mark("CHILD_EXIT", `code=${code} sig=${sig}`));
mark("SPAWNED", `pid=${child.pid} defer=${DEFER}`);

const H = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};
const jf = async (url, init) => {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

let firstHttp = 0;
let healthReadyAt = 0;
let statusCanRespondAt = 0;
let statusRunningAt = 0;
let chatRepliedAt = 0;
let firstAnyReplyAt = 0;
let chatReplyText = "";
let convId = null;
let lastHealth = "";
let lastStatus = "";
let chatSentAt = 0;
let chatInFlight = false;

async function pollOnce() {
  // /api/health — the desktop launcher's boot gate
  try {
    const { status, body } = await jf(`${BASE}/api/health`, { headers: H });
    if (!firstHttp) {
      firstHttp = Date.now() - t0;
      mark("HTTP_ACCEPTING", `health HTTP ${status}`);
    }
    const sig = JSON.stringify({
      s: status,
      ready: body?.ready,
      canRespond: body?.canRespond,
      st: body?.agentState,
    });
    if (sig !== lastHealth) {
      lastHealth = sig;
      mark("HEALTH_CHANGE", sig);
      if (body?.ready === true && !healthReadyAt) {
        healthReadyAt = Date.now() - t0;
        mark("HEALTH_READY_TRUE");
      }
    }
  } catch {
    /* not accepting yet */
  }
  // /api/status — the app shell readiness poll (deriveAgentReady ← canRespond)
  try {
    const { status, body } = await jf(`${BASE}/api/status`, { headers: H });
    const sig = JSON.stringify({
      s: status,
      state: body?.state,
      canRespond: body?.canRespond,
      model: body?.model ?? null,
    });
    if (sig !== lastStatus) {
      lastStatus = sig;
      mark("STATUS_CHANGE", sig);
      if (body?.state === "running" && !statusRunningAt) {
        statusRunningAt = Date.now() - t0;
        mark("STATUS_STATE_RUNNING");
      }
      if (body?.canRespond === true && !statusCanRespondAt) {
        statusCanRespondAt = Date.now() - t0;
        mark("STATUS_CANRESPOND_TRUE");
      }
    }
  } catch {
    /* not accepting yet */
  }
}

async function chatAttempt() {
  if (chatRepliedAt || chatInFlight || !firstHttp) return;
  chatInFlight = true;
  try {
    if (!convId) {
      const { status, body } = await jf(`${BASE}/api/conversations`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ title: "wakeprobe" }),
      });
      if (status === 200 && body?.conversation?.id) {
        convId = body.conversation.id;
        mark("CONV_CREATED", `id=${convId}`);
      } else {
        mark(
          "CONV_CREATE_FAIL",
          `HTTP ${status} ${JSON.stringify(body).slice(0, 160)}`,
        );
      }
    }
    if (convId && !chatSentAt) {
      chatSentAt = Date.now() - t0;
      const { status, body } = await jf(
        `${BASE}/api/conversations/${convId}/messages`,
        {
          method: "POST",
          headers: H,
          body: JSON.stringify({ text: "ping — reply with one word" }),
        },
      );
      if (
        status === 200 &&
        typeof body?.text === "string" &&
        body.text.trim()
      ) {
        const text = body.text.trim().slice(0, 120);
        const modelBacked = !/no llm provider|not configured|configure/i.test(
          text,
        );
        if (!firstAnyReplyAt) {
          firstAnyReplyAt = Date.now() - t0;
          mark("CHAT_REPLIED_ANY", `HTTP 200 text=${JSON.stringify(text)}`);
        }
        if (modelBacked && !chatRepliedAt) {
          chatRepliedAt = Date.now() - t0;
          chatReplyText = text;
          mark("CHAT_REPLIED_MODEL", `HTTP 200 text=${JSON.stringify(text)}`);
        } else if (!modelBacked) {
          mark("CHAT_REPLY_NOPROVIDER", JSON.stringify(text.slice(0, 60)));
          chatSentAt = 0; // keep probing until a model-backed reply lands
        }
      } else {
        mark(
          "CHAT_FAIL",
          `HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`,
        );
        chatSentAt = 0; // retry
      }
    }
  } catch (err) {
    mark("CHAT_ERROR", String(err).slice(0, 160));
    chatSentAt = 0;
  } finally {
    chatInFlight = false;
  }
}

const iv = setInterval(pollOnce, 250);
const civ = setInterval(chatAttempt, 1500);

const done = () =>
  (chatRepliedAt && statusCanRespondAt && healthReadyAt) ||
  Date.now() - t0 > TIMEOUT_MS;
await new Promise((resolve) => {
  const check = setInterval(() => {
    if (done()) {
      clearInterval(check);
      resolve();
    }
  }, 500);
});
// small settle to catch trailing flips
await new Promise((r) => setTimeout(r, 4000));
await pollOnce();
clearInterval(iv);
clearInterval(civ);

console.log("\n=== WAKE-STATUS SIGNAL TIMELINE (develop tip, server lane) ===");
console.log(`defer_app_routes=${DEFER}`);
const fmt = (v) => (v ? `${(v / 1000).toFixed(2)}s` : "NEVER (within timeout)");
console.log(`HTTP accepting (API bound):        ${fmt(firstHttp)}`);
console.log(`first chat reply (any):            ${fmt(firstAnyReplyAt)}`);
console.log(
  `first MODEL-backed chat reply:     ${fmt(chatRepliedAt)}   reply=${JSON.stringify(chatReplyText)}`,
);
console.log(`/api/status state=running:         ${fmt(statusRunningAt)}`);
console.log(
  `/api/status canRespond=true:       ${fmt(statusCanRespondAt)}   <-- deriveAgentReady flips here (banner clears)`,
);
console.log(
  `/api/health ready=true:            ${fmt(healthReadyAt)}   <-- desktop launcher boot gate`,
);
if (chatRepliedAt && statusCanRespondAt) {
  console.log(
    `GAP chat-replied -> canRespond:    ${((statusCanRespondAt - chatRepliedAt) / 1000).toFixed(2)}s`,
  );
}
fs.writeFileSync(
  path.join(DIR, "timeline.json"),
  JSON.stringify(
    {
      defer: DEFER,
      firstHttp,
      chatRepliedAt,
      statusRunningAt,
      statusCanRespondAt,
      healthReadyAt,
      events,
    },
    null,
    2,
  ),
);

child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
try {
  child.kill("SIGKILL");
} catch {}
process.exit(0);
