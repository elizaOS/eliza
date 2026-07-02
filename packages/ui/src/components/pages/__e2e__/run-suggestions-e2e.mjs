/**
 * End-to-end e2e for proactive suggestions (#8792) — server pipeline → rendered,
 * clickable UI. Two phases, one run:
 *
 * PHASE 1 (this bun process, REAL server modules — no HTTP mocks, no mocked
 * governor): fires real interaction reports through the real route handlers and
 * the real registered decider + governance gate:
 *
 *   POST /api/views/:id/navigate      → EventType.VIEW_SWITCHED
 *   POST /api/interactions/shortcut   → EventType.SHORTCUT_FIRED
 *   EventType.SLASH_COMMAND_INVOKED   → (policy-silent by design)
 *     → registerProactiveInteractionDecider (real debounce timers)
 *       → small-model judge (scripted output — the judge model is not under
 *         test here; a LIVE judge trajectory is captured separately in the
 *         issue evidence)
 *         → REAL ProactiveInteractionGate (observed subclass: super.tryAdmit
 *           does all the deciding; we only record its verdicts)
 *           → REAL routeAutonomyTextToUser → memory persist + broadcast
 *             {type:"proactive-message", message:{source:"proactive-interaction"}}
 *
 * Sequence proves the governance for real (a virtual clock is injected via the
 * decider's documented `now` seam; the debounce timers run in real time):
 *   s1 navigate wallet (user)        → ADMITTED  → frame 1
 *   s2 navigate calendar in burst    → judge runs, gate SUPPRESSES (global cooldown)
 *   s3 slash command                 → policy-silent (judge never called)
 *   s4 control shortcut (focus-composer) → policy-silent (judge never called)
 *   s5 navigate settings (agent-initiated) → skipped (already acknowledged)
 *   s6 +130s shortcut open-command-palette → ADMITTED → frame 2
 *   s7 +260s navigate wallet again   → SUPPRESSED (per-surface cooldown)
 *   s8 chattiness=off, navigate      → suppressed before the judge (kill switch)
 *   s9 +760s same shortcut, same text → SUPPRESSED (textual dedup)
 *
 * PHASE 2 (headless Chromium): feeds the REAL captured frames through the real
 * `parseProactiveMessageEvent` parser into the real ChatTranscript/ChatMessage
 * composites (suggestions-fixture.tsx) and exercises the #8792 affordance with
 * real clicks: suggestion bubble renders (Suggestion chip + "Do it" + dismiss),
 * malformed/foreign/duplicate frames are rejected, Dismiss removes the bubble,
 * "Do it" sends the acceptance turn and clears the bubble. Screenshots + video.
 *
 * Run: bun run --cwd packages/ui test:suggestions-e2e
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { EventType } from "@elizaos/core";
import { build } from "esbuild";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = join(here, "..", "..", "..", "..", "..", "agent", "src");

const { handleViewsRoutes, clearCurrentViewState } = await import(
  join(agentSrc, "api", "views-routes.ts")
);
const { registerBuiltinViews } = await import(
  join(agentSrc, "api", "views-registry.ts")
);
const { handleInteractionsRoutes } = await import(
  join(agentSrc, "api", "interactions-routes.ts")
);
const { routeAutonomyTextToUser } = await import(
  join(agentSrc, "api", "server-helpers-swarm.ts")
);
const { registerProactiveInteractionDecider, PROACTIVE_INTERACTION_SOURCE } =
  await import(join(agentSrc, "services", "proactive-interaction-decider.ts"));
const { ProactiveInteractionGate } = await import(
  join(agentSrc, "services", "proactive-interaction-gate.ts")
);

const outDir = join(here, "output-suggestions");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// ── PHASE 1: real server pipeline ───────────────────────────────────────────

console.log("— phase 1: real routes → decider → gate → broadcast —");

// The decider kill-switch env vars must not leak in from the shell.
delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
delete process.env.ELIZA_PROACTIVE_INTERACTIONS;

const ROOM_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const CONVERSATION_ID = "conv-1";

/** Virtual clock injected through the decider's documented `now` seam. */
const T0 = Date.UTC(2026, 6, 2, 12, 0, 0);
let vnow = T0;

/** Real gate, observed: super.tryAdmit makes every decision; we just log it. */
const gateDecisions = [];
class ObservedGate extends ProactiveInteractionGate {
  tryAdmit(input) {
    const result = super.tryAdmit(input);
    gateDecisions.push({
      surface: input.surface,
      text: input.text,
      atMs: input.now - T0,
      ...result,
    });
    return result;
  }
}

// Scripted small-model judge outputs, consumed in call order.
const judgeOutputs = [
  '{"comment":"Want me to pull your latest balances?","delivery":"chat","confidence":0.9,"urgency":"medium"}',
  '{"comment":"Here is a calendar tip.","delivery":"chat","confidence":0.9,"urgency":"medium"}',
  '{"comment":"Want a hand finding something?","delivery":"chat","confidence":0.85,"urgency":"medium"}',
  '{"comment":"Want me to refresh your wallet view?","delivery":"chat","confidence":0.9,"urgency":"medium"}',
  '{"comment":"Want a hand finding something?","delivery":"chat","confidence":0.85,"urgency":"medium"}',
];
let judgeCalls = 0;

const events = {};
const frames = [];
const createdMemories = [];
let chattiness = "subtle";

const runtime = {
  agentId: AGENT_ID,
  registerEvent(event, handler) {
    (events[event] ??= []).push(handler);
  },
  async emitEvent(event, params) {
    const handlers = events[event];
    if (!handlers) return;
    const payload = {
      ...params,
      runtime,
      source: typeof params.source === "string" ? params.source : "runtime",
    };
    await Promise.all(handlers.map((h) => h(payload)));
  },
  async useModel() {
    judgeCalls += 1;
    return judgeOutputs[judgeCalls - 1] ?? '{"comment":null}';
  },
  getSetting(key) {
    return key === "ELIZA_PROACTIVE_INTERACTIONS" ? chattiness : undefined;
  },
  async createMemory(memory) {
    createdMemories.push(memory);
    return memory;
  },
};

const state = {
  runtime,
  activeConversationId: CONVERSATION_ID,
  conversations: new Map([
    [
      CONVERSATION_ID,
      {
        id: CONVERSATION_ID,
        roomId: ROOM_ID,
        updatedAt: new Date(T0).toISOString(),
      },
    ],
  ]),
  broadcastWs: (data) => {
    frames.push(data);
  },
};

registerBuiltinViews();
clearCurrentViewState();

const gate = new ObservedGate();
registerProactiveInteractionDecider(runtime, {
  gate,
  route: (text) =>
    routeAutonomyTextToUser(state, text, PROACTIVE_INTERACTION_SOURCE),
  now: () => vnow,
});

const noopRes = {};
const jsonNoop = () => {};
const errors400 = [];
const errorCapture = (_res, message, status) => {
  errors400.push({ message, status });
};

async function postNavigate(viewId, body) {
  const pathname = `/api/views/${encodeURIComponent(viewId)}/navigate`;
  await handleViewsRoutes({
    req: Readable.from([Buffer.from(JSON.stringify(body))]),
    res: noopRes,
    method: "POST",
    pathname,
    url: new URL(`http://local${pathname}`),
    json: jsonNoop,
    error: errorCapture,
    broadcastWs: jsonNoop,
    runtime,
  });
}

async function postShortcut(shortcutId) {
  await handleInteractionsRoutes({
    req: Readable.from([Buffer.from(JSON.stringify({ shortcutId }))]),
    res: noopRes,
    method: "POST",
    pathname: "/api/interactions/shortcut",
    json: jsonNoop,
    error: errorCapture,
    runtime,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the decider's real debounce timer (1500ms at "subtle") fire. */
async function flushDebounce() {
  vnow += 1_600;
  await sleep(1_750);
}
const proactiveFrames = () =>
  frames.filter((f) => f.type === "proactive-message");

// s1 — navigate wallet (user) → admitted comment.
await postNavigate("wallet", { source: "user" });
await flushDebounce();
assert(judgeCalls === 1, "s1: view-switch reached the small-model judge");
assert(
  proactiveFrames().length === 1 &&
    proactiveFrames()[0].message.source === PROACTIVE_INTERACTION_SOURCE &&
    proactiveFrames()[0].message.text ===
      "Want me to pull your latest balances?",
  "s1: wallet switch produced a governed proactive-message frame",
);
assert(
  createdMemories.length === 1,
  "s1: the admitted comment was persisted to the conversation",
);

// s2 — immediate second navigate: the judge runs but the REAL gate suppresses
// on the global cooldown (120s at "subtle").
await postNavigate("calendar", { source: "user" });
await flushDebounce();
assert(judgeCalls === 2, "s2: burst switch still consulted the judge");
assert(
  proactiveFrames().length === 1,
  "s2: burst switch was rate-limited (no second frame)",
);
assert(
  gateDecisions.at(-1)?.admitted === false &&
    gateDecisions.at(-1)?.reason === "global cooldown",
  `s2: gate recorded the suppression reason (${gateDecisions.at(-1)?.reason})`,
);

// s3 — explicit slash command: policy-silent, judge never called.
await runtime.emitEvent(EventType.SLASH_COMMAND_INVOKED, {
  command: "help",
  initiatedBy: "user",
});
await sleep(50);
assert(
  judgeCalls === 2 && proactiveFrames().length === 1,
  "s3: slash command stayed policy-silent (no judge call, no frame)",
);

// s4 — control shortcut: denied before the judge (gesture, not intent).
await postShortcut("focus-composer");
await sleep(50);
assert(
  judgeCalls === 2 && proactiveFrames().length === 1,
  "s4: control shortcut (focus-composer) never reached the judge",
);

// s5 — agent-initiated navigation: already acknowledged, no comment.
await postNavigate("settings", { source: "agent" });
await flushDebounce();
assert(
  judgeCalls === 2 && proactiveFrames().length === 1,
  "s5: agent-initiated switch produced no proactive comment",
);

// s6 — past the global cooldown, an intent-bearing shortcut is admitted.
vnow = T0 + 130_000;
await postShortcut("open-command-palette");
await flushDebounce();
assert(judgeCalls === 3, "s6: intent-bearing shortcut reached the judge");
assert(
  proactiveFrames().length === 2 &&
    proactiveFrames()[1].message.text === "Want a hand finding something?",
  "s6: clock-advanced shortcut was admitted (second frame)",
);

// s7 — wallet again: global cooldown has passed, but the per-surface cooldown
// (10min at "subtle") still suppresses.
vnow = T0 + 260_000;
await postNavigate("wallet", { source: "user" });
await flushDebounce();
assert(judgeCalls === 4, "s7: repeat wallet switch consulted the judge");
assert(
  proactiveFrames().length === 2 &&
    gateDecisions.at(-1)?.admitted === false &&
    gateDecisions.at(-1)?.reason === "per-surface cooldown",
  `s7: per-surface cooldown suppressed the repeat (${gateDecisions.at(-1)?.reason})`,
);

// s8 — user setting "off" (the CapabilitiesSection control) kills the decider
// before the judge spends a model call.
chattiness = "off";
vnow = T0 + 400_000;
await postNavigate("calendar", { source: "user" });
await flushDebounce();
assert(
  judgeCalls === 4 && proactiveFrames().length === 2,
  "s8: chattiness=off suppressed the interaction before the judge",
);
chattiness = "subtle";

// s9 — same shortcut, same judge text, past both cooldowns: textual dedup.
vnow = T0 + 760_000;
await postShortcut("open-command-palette");
await flushDebounce();
assert(judgeCalls === 5, "s9: dedup candidate consulted the judge");
assert(
  proactiveFrames().length === 2 &&
    gateDecisions.at(-1)?.admitted === false &&
    gateDecisions.at(-1)?.reason === "duplicate of a recent comment",
  `s9: textual dedup suppressed the identical offer (${gateDecisions.at(-1)?.reason})`,
);

assert(errors400.length === 0, "phase 1: no route rejected a valid report");

console.log("  gate ledger:");
for (const d of gateDecisions) {
  console.log(
    `    t+${String(d.atMs / 1000).padStart(5)}s ${d.admitted ? "ADMIT   " : "SUPPRESS"} [${d.surface}] ${d.reason}`,
  );
}
await writeFile(
  join(outDir, "phase1-pipeline.json"),
  `${JSON.stringify({ frames, gateDecisions, judgeCalls, memories: createdMemories.length }, null, 2)}\n`,
);

const captured = proactiveFrames();

// ── PHASE 2: real browser — captured frames → rendered suggestion UI ────────

console.log("— phase 2: captured frames → real ChatTranscript in Chromium —");

// `state/parsers` re-exports streaming-text helpers whose canonical home is
// @elizaos/shared; the shared BARREL drags http-helpers → the @elizaos/core
// node barrel into a browser bundle. Vite resolves the published browser
// condition here; for this esbuild fixture we alias the barrel to the exact
// (pure, browser-safe) module the fixture graph actually consumes.
const sharedStreamingText = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "..",
  "shared",
  "src",
  "utils",
  "streaming-text.ts",
);
const aliasSharedBarrel = {
  name: "alias-shared-barrel",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/shared$/ }, () => ({
      path: sharedStreamingText,
    }));
  },
};

const bundle = await build({
  entryPoints: [join(here, "suggestions-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [aliasSharedBarrel],
  write: false,
});
const js = bundle.outputFiles[0].text;
// Map the design tokens the suggestion treatment uses (accent/dashed border /
// tinted bubble) onto the brand orange so the rendered affordance is honest.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>suggestions e2e</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{accent:"#ef5a1f","txt-strong":"#18181b",muted:"#71717a",surface:"#fafafa",border:"#e4e4e7"},fontSize:{"xs-tight":["11px","14px"]}}}}</script>
<style>html,body{margin:0;height:100%;background:#f4f4f5}</style>
</head><body><div id="root"></div><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "suggestions.html");
await writeFile(htmlPath, html);

let shot = 0;
async function snap(p, name) {
  shot += 1;
  const file = `sg-${String(shot).padStart(2, "0")}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  console.log(`  📸 ${file}`);
}

const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
});
const context = await browser.newContext({
  viewport: { width: 900, height: 700 },
  recordVideo: { dir: outDir, size: { width: 900, height: 700 } },
});
const pageErrors = [];
const p = await context.newPage();
p.on("pageerror", (e) => {
  pageErrors.push(String(e));
  console.error(`  ⚠ pageerror: ${e}`);
});

const bubbleCount = () => p.locator('[data-proactive-suggestion="true"]').count();

try {
  await p.goto(`file://${htmlPath}`);
  await p.waitForSelector('[data-testid="suggestions-fixture-root"]', {
    timeout: 8_000,
  });

  // 1. First REAL captured frame → suggestion bubble with the full affordance.
  const r1 = await p.evaluate((f) => window.__deliverWsFrame?.(f), captured[0]);
  await p.waitForTimeout(250);
  assert(r1?.delivered === true, "frame 1 (real capture) parsed and appended");
  assert((await bubbleCount()) === 1, "one suggestion bubble rendered");
  assert(
    await p
      .locator('[data-proactive-suggestion="true"]')
      .getByText("Want me to pull your latest balances?")
      .isVisible(),
    "the bubble shows the governed comment text",
  );
  assert(
    await p.getByText("Suggestion", { exact: true }).isVisible(),
    'the bubble carries the "Suggestion" chip (not a normal reply)',
  );
  assert(
    (await p.getByRole("button", { name: "Do it" }).count()) === 1 &&
      (await p.getByRole("button", { name: "Dismiss suggestion" }).count()) ===
        1,
    'the bubble exposes the "Do it" and dismiss affordances',
  );
  await snap(p, "suggestion-rendered");

  // 2. Malformed frame (no message id) → real parser rejects, UI unchanged.
  const rBad = await p.evaluate(
    (f) => window.__deliverWsFrame?.(f),
    {
      type: "proactive-message",
      conversationId: CONVERSATION_ID,
      message: { role: "assistant", text: "broken", timestamp: 1 },
    },
  );
  assert(
    rBad?.delivered === false && (await bubbleCount()) === 1,
    `malformed frame is rejected by the real parser (${rBad?.reason})`,
  );

  // 3. Frame for another conversation → unread marker, not a bubble.
  const rOther = await p.evaluate(
    (f) => window.__deliverWsFrame?.(f),
    {
      ...captured[0],
      conversationId: "conv-2",
      message: { ...captured[0].message, id: randomUUID() },
    },
  );
  const unread = await p.evaluate(() => window.__unreadConversations);
  assert(
    rOther?.delivered === false &&
      (await bubbleCount()) === 1 &&
      unread?.includes("conv-2"),
    "a frame for an inactive conversation goes to unread, not the transcript",
  );

  // 4. Second REAL captured frame → second bubble.
  await p.evaluate((f) => window.__deliverWsFrame?.(f), captured[1]);
  await p.waitForTimeout(250);
  assert((await bubbleCount()) === 2, "second governed frame renders a second bubble");
  await snap(p, "two-suggestions");

  // 5. Redelivering the same frame (reconnect replay) is id-deduped.
  const rDup = await p.evaluate((f) => window.__deliverWsFrame?.(f), captured[1]);
  assert(
    rDup?.reason === "id-deduped" && (await bubbleCount()) === 2,
    "replaying an already-delivered frame does not duplicate the bubble",
  );

  // 6. Dismiss the first suggestion → bubble removed, nothing sent.
  await p.getByRole("button", { name: "Dismiss suggestion" }).first().click();
  await p.waitForTimeout(250);
  assert((await bubbleCount()) === 1, "dismiss removes the suggestion bubble");
  assert(
    (await p.evaluate(() => window.__sentTexts))?.length === 0,
    "dismiss sends nothing to the agent",
  );
  await snap(p, "after-dismiss");

  // 7. Accept ("Do it") the remaining suggestion → acceptance turn sent, bubble cleared.
  await p.getByRole("button", { name: "Do it" }).click();
  await p.waitForTimeout(250);
  const sent = await p.evaluate(() => window.__sentTexts);
  assert((await bubbleCount()) === 0, '"Do it" clears the suggestion bubble');
  assert(
    Array.isArray(sent) && sent.length === 1 && sent[0] === "Yes, let's do it.",
    '"Do it" sends the acceptance as a normal chat turn',
  );
  await snap(p, "after-accept");
} finally {
  await context.close(); // flush the video
  await browser.close();
}

for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm") && f !== "walkthrough.webm") {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
    console.log("  🎥 walkthrough.webm");
    break;
  }
}

assert(pageErrors.length === 0, `no uncaught page errors (${pageErrors.length})`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n✅ proactive suggestions e2e passed");
process.exit(0);
