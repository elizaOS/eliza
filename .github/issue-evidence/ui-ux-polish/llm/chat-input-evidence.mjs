#!/usr/bin/env node
// Standalone Playwright evidence capture for the ui-ux-polish LLM lane:
// opens the app served by the ui-smoke LIVE stack (real backend agent + live
// Cerebras model), types a real message into the chat composer, sends it,
// waits for the real assistant reply, and records video + HAR + console log.
// No mocks: every request goes to the real stack on ELIZA_UI_SMOKE_PORT.
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const UI_PORT = process.env.ELIZA_UI_SMOKE_PORT || "2168";
const BASE = `http://127.0.0.1:${UI_PORT}`;
const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: chat-input-evidence.mjs <output-dir>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const consoleLines = [];
const networkLines = [];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  recordHar: { path: join(OUT, "chat-input-network.har"), content: "embed" },
});
const page = await context.newPage();

page.on("console", (msg) => {
  consoleLines.push(
    `${new Date().toISOString()} [${msg.type()}] ${msg.text()}`,
  );
});
page.on("pageerror", (err) => {
  consoleLines.push(`${new Date().toISOString()} [pageerror] ${err.message}`);
});
page.on("response", (res) => {
  networkLines.push(
    `${new Date().toISOString()} ${res.status()} ${res.request().method()} ${res.url()}`,
  );
});

// Same storage seed the ui-smoke helpers use so the once-ever tour/tutorial
// does not interpose; the backend first-run is already genuinely completed by
// the live stack via POST /api/first-run against the real API.
await page.addInitScript(() => {
  localStorage.setItem("eliza:first-run-complete", "1");
  localStorage.setItem("eliza:setup:step", "activate");
  localStorage.setItem("eliza:ui-shell-mode", "native");
  localStorage.setItem("eliza:tutorial-autolaunched", "1");
  localStorage.setItem(
    "elizaos:active-server",
    JSON.stringify({ id: "local:embedded", kind: "local", label: "This device" }),
  );
});

const COMPOSER =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const SEND =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';

const step = (label) => console.log(`[evidence] ${label}`);

try {
  step(`goto ${BASE}/chat`);
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  let composer = page.locator(COMPOSER).first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });

  // Fresh conversation so no prior-run thread lines can satisfy the reply
  // locator (same approach as live-agent-chat.spec.ts).
  step("create fresh conversation via real /api/conversations");
  const created = await page.evaluate(async () => {
    const res = await fetch("/api/conversations", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ui-ux-polish chat-input evidence" }),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  });
  if (!created.ok) {
    throw new Error(`conversation create failed: ${created.status} ${created.text.slice(0, 300)}`);
  }
  const conversationId = JSON.parse(created.text)?.conversation?.id;
  if (!conversationId) throw new Error("no conversation id in create response");
  await page.evaluate((id) => {
    localStorage.setItem("eliza:chat:activeConversationId", id);
  }, conversationId);
  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
  composer = page.locator(COMPOSER).first();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  await page.screenshot({ path: join(OUT, "01-chat-ready.png"), fullPage: true });

  const prompt =
    "In one short sentence, what is elizaOS? (ui-ux-polish live chat-input e2e)";
  step(`fill composer: ${prompt}`);
  await composer.fill(prompt);
  await page.screenshot({ path: join(OUT, "02-composer-filled.png"), fullPage: true });

  step("click send");
  await page.locator(SEND).first().click();

  // user message rendered
  const userLine = page
    .locator('[data-testid="chat-message"][data-role="user"], [data-testid="thread-line"]')
    .filter({ hasText: "what is elizaOS" })
    .first();
  await userLine.waitFor({ state: "visible", timeout: 30_000 });
  await page.screenshot({ path: join(OUT, "03-user-message-sent.png"), fullPage: true });

  // Real assistant reply: role-tagged assistant message, or (overlay transcript)
  // any thread-line that is not the user's own prompt — safe in this fresh
  // conversation because the only prior line is the prompt itself.
  step("wait for real assistant reply");
  const assistant = page
    .locator('[data-testid="chat-message"][data-role="assistant"]')
    .last()
    .or(
      page
        .locator('[data-testid="thread-line"]')
        .filter({ hasNotText: "ui-ux-polish live chat-input e2e" })
        .last(),
    )
    .first();
  await assistant.waitFor({ state: "visible", timeout: 120_000 });
  // let streaming settle
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const cur = ((await assistant.innerText().catch(() => "")) ?? "").trim();
    if (cur && cur === prev) break;
    prev = cur;
    await page.waitForTimeout(500);
  }
  const assistantText = prev;
  if (!assistantText) throw new Error("assistant reply rendered empty text");
  step(`assistant replied (${assistantText.length} chars): ${assistantText.slice(0, 200)}`);
  await page.screenshot({ path: join(OUT, "04-assistant-replied.png"), fullPage: true });

  writeFileSync(
    join(OUT, "chat-input-exchange.json"),
    JSON.stringify(
      {
        base: BASE,
        prompt,
        assistantText,
        capturedAt: new Date().toISOString(),
        provider: "cerebras (via @elizaos/plugin-openai, api.cerebras.ai)",
      },
      null,
      2,
    ),
  );
  console.log("[evidence] PASS");
} catch (err) {
  console.error(`[evidence] FAIL: ${err?.message ?? err}`);
  await page.screenshot({ path: join(OUT, "99-failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "chat-input-console.txt"), consoleLines.join("\n") + "\n");
  writeFileSync(join(OUT, "chat-input-network.txt"), networkLines.join("\n") + "\n");
  await context.close(); // flushes video + HAR
  await browser.close();
  // rename the random-named video
  const video = readdirSync(OUT).find((f) => f.endsWith(".webm"));
  if (video && video !== "chat-input-live.webm") {
    renameSync(join(OUT, video), join(OUT, "chat-input-live.webm"));
  }
}
