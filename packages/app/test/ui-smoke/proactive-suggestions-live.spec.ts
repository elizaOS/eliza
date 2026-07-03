// LIVE e2e for proactive interaction suggestions (#8792 / #11387).
//
// Drives the WHOLE shipped pipeline against the REAL app + REAL runtime + a
// LIVE LLM judge — no stubs, no injected frames:
//
//   real user view-switch (command palette)                      [CommandPalette]
//     → POST /api/views/:id/navigate { source: "user" }          [reportUserViewSwitch]
//       → emitEvent(VIEW_SWITCHED, { initiatedBy: "user" })      [views-routes]
//         → decider debounce + LIVE small-model judge            [proactive-interaction-decider]
//           → governance gate (cooldowns / cap / dedup)          [ProactiveInteractionGate]
//             → routeAutonomyTextToUser → WS proactive-message   [server-helpers-swarm]
//               → rendered data-proactive-suggestion="true"      [chat-message.tsx]
//
// Phases (all under the DEFAULT "subtle" governance: 2 min global cooldown,
// 10 min per-surface cooldown, 1.5 s settle debounce):
//   1. view switch → a governed suggestion bubble renders in chat, with the
//      distinct Suggestion affordance ("Do it" + dismiss), and the offer is a
//      persisted agent memory with source "proactive-interaction"
//   2. an immediate second view switch is judge-evaluated but gate-suppressed
//      (global cooldown) — no second bubble, no second persisted memory
//   3. dismiss removes the bubble from the transcript
//   4. after the cooldown, a fresh-surface switch admits a second suggestion;
//      "Do it" sends the real accept turn ("Yes, let's do it.") to the live
//      agent and clears the bubble; the live agent answers the accepted offer
//   5. the real Settings → Capabilities "Proactive suggestions = Off" control
//      kills the pipeline pre-judge — a further switch renders and persists
//      nothing new
//
// Persona note (real finding, kept deliberately): with the default smoke
// persona the live judge consistently labels helpful view offers as
// `urgency: "low"`, which the shipped parser routes to the quiet notification
// rail instead of chat (parseProactiveJudgeDecisionOutput). The judge's system
// prompt IS the agent character (a user-tunable product surface), so this spec
// first sets a chat-forward persona through the real PUT /api/character API —
// after which the same live judge labels offers medium-urgency and the chat
// rail is exercised deterministically. The judge output itself stays entirely
// model-generated.
//
// Dismissal is deliberately local-only in the product (the server-side
// per-surface cooldown stops immediate re-noise), so a full page reload
// rehydrates past suggestions from conversation history. The spec therefore
// navigates in-SPA between phases 1–4 and switches to delta-based bubble
// assertions after any reload.
//
// LIVE_ONLY: needs the real runtime + a live provider. Local, keyless run:
//   LD_LIBRARY_PATH=<build>/bin <build>/bin/llama-server \
//     -m ~/models/eliza-1-4b-128k.gguf --port 18811 --jinja \
//     --chat-template-kwargs '{"enable_thinking":false}'
//   ELIZA_UI_SMOKE_LIVE_STACK=1 LOCAL_LLAMA_CPP_API_KEY=local \
//   ELIZA_LIVE_TEST_LOCAL_LLAMA_CPP_BASE_URL=http://127.0.0.1:18811/v1 \
//   ELIZA_LIVE_TEST_SMALL_MODEL=eliza-1-4b ELIZA_LIVE_TEST_LARGE_MODEL=eliza-1-4b \
//     bun run --cwd packages/app test:e2e test/ui-smoke/proactive-suggestions-live.spec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "output", "proactive-suggestions");

// Governance numbers under the DEFAULT "subtle" chattiness
// (packages/agent/src/services/proactive-interaction-gate.ts).
const GLOBAL_COOLDOWN_MS = 2 * 60_000;
const SETTLE_DEBOUNCE_MS = 1_500;
// Live-judge latency ceiling (local CPU llama-server, ~4B model).
const JUDGE_WAIT_MS = 150_000;
// How long phase 2 watches for a (wrong) second bubble. Long enough for the
// suppressed switch's judge round-trip to have completed either way.
const SUPPRESSION_WATCH_MS = 100_000;

const CHAT_COMPOSER = '[data-testid="chat-composer-textarea"]';
const CHAT_SEND =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
const SUGGESTION_BUBBLE = '[data-proactive-suggestion="true"]';
// The shipped chat surface is the ContinuousChatOverlay thread (#10713):
// messages render as thread-lines inside the sheet.
const ASSISTANT_MESSAGE = '[data-testid="thread-line"][data-role="assistant"]';
const USER_MESSAGE = '[data-testid="thread-line"][data-role="user"]';

const STEERED_PERSONA_SUFFIX =
  " You are enthusiastic about proactively helping in chat: when you decide" +
  " to offer a proactive suggestion for the view the user is on, you consider" +
  " a visible chat suggestion genuinely useful and time-relevant, so you rate" +
  " its urgency as medium (never low) and deliver it in chat.";

interface NetLogEntry {
  t: string;
  kind: "request" | "response" | "ws";
  detail: string;
}

function suggestionBubbles(page: Page): Locator {
  return page.locator(SUGGESTION_BUBBLE);
}

/** Full-page screenshot into the spec output dir (evidence source). */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
}

/**
 * Trigger a REAL user view switch through the command palette and wait for the
 * client's `POST /api/views/:id/navigate` report to succeed. The palette open
 * itself reports a SHORTCUT_FIRED interaction; the whole open→select gesture
 * stays well inside the 1.5 s settle debounce, so the decider supersedes the
 * shortcut surface with the view surface (exactly what a fast human does).
 */
async function switchViewViaPalette(
  page: Page,
  query: string,
  expectViewIdPattern: RegExp,
): Promise<string> {
  const navigateReported = page.waitForResponse(
    (res) =>
      res.request().method() === "POST" &&
      /\/api\/views\/[^/]+\/navigate(?:\?|$)/.test(res.url()) &&
      res.ok(),
    { timeout: 20_000 },
  );
  await page.keyboard.press("ControlOrMeta+k");
  const paletteInput = page.getByLabel("Search commands");
  await expect(paletteInput).toBeVisible({ timeout: 5_000 });
  await paletteInput.fill(query);
  await paletteInput.press("Enter");
  const res = await navigateReported;
  const viewId = decodeURIComponent(
    /\/api\/views\/([^/]+)\/navigate/.exec(res.url())?.[1] ?? "",
  );
  expect(viewId, `palette query "${query}" reported a view switch`).toMatch(
    expectViewIdPattern,
  );
  return viewId;
}

/**
 * Open the overlay's thread sheet if it is not already open — the transcript
 * (thread-lines + suggestion bubbles) only renders inside the open sheet.
 */
async function ensureThreadOpen(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  if ((await overlay.getAttribute("data-open")) !== "true") {
    await page.getByTestId("chat-sheet-grabber").click();
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });
  }
}

/** In-SPA return to the chat transcript (no reload — see header note). */
async function backToChat(page: Page): Promise<void> {
  if (!page.url().includes("/chat")) {
    await page.goBack().catch(() => {});
  }
  await expect(page.locator(CHAT_COMPOSER).first()).toBeVisible({
    timeout: 20_000,
  });
  await ensureThreadOpen(page);
}

/** Read the agent's persisted suggestion memories through the real API. */
async function fetchProactiveMessages(
  page: Page,
  conversationId: string,
): Promise<Array<{ text: string; source: string }>> {
  const data = (await page.evaluate(async (cid) => {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(cid)}/messages`,
    );
    if (!res.ok) return null;
    return res.json();
  }, conversationId)) as {
    messages?: Array<{ text?: string; source?: string }>;
  } | null;
  const messages = data?.messages ?? [];
  return messages
    .filter((m) => m.source === "proactive-interaction")
    .map((m) => ({ text: m.text ?? "", source: m.source ?? "" }));
}

test.describe("proactive interaction suggestions — live pipeline", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real runtime + a live LLM judge (ELIZA_UI_SMOKE_LIVE_STACK=1); " +
      "the keyless stub has no event bus, decider, or governance gate.",
  );

  test("view switch → governed suggestion → dismiss / rate-limit / accept / off", async ({
    page,
  }) => {
    // Live judge round-trips on CPU inference: give the whole journey room.
    test.setTimeout(1_800_000);
    mkdirSync(OUT, { recursive: true });

    // ── Evidence taps: console, network, websocket frames ──────────────────
    const consoleLog: string[] = [];
    const netLog: NetLogEntry[] = [];
    page.on("console", (msg) => {
      consoleLog.push(
        `[${new Date().toISOString()}] ${msg.type()}: ${msg.text()}`,
      );
    });
    page.on("request", (req) => {
      if (/\/api\/(views|interactions|config|character)/.test(req.url())) {
        netLog.push({
          t: new Date().toISOString(),
          kind: "request",
          detail: `${req.method()} ${req.url()} ${req.postData() ?? ""}`,
        });
      }
    });
    page.on("response", (res) => {
      if (/\/api\/(views|interactions|config|character)/.test(res.url())) {
        netLog.push({
          t: new Date().toISOString(),
          kind: "response",
          detail: `${res.status()} ${res.request().method()} ${res.url()}`,
        });
      }
    });
    page.on("websocket", (ws) => {
      ws.on("framereceived", (frame) => {
        const payload =
          typeof frame.payload === "string"
            ? frame.payload
            : frame.payload.toString("utf8");
        if (payload.includes("proactive-message")) {
          netLog.push({
            t: new Date().toISOString(),
            kind: "ws",
            detail: payload.slice(0, 2_000),
          });
        }
      });
    });

    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/chat");

    // ── Anchor a conversation with one real live chat turn ─────────────────
    // Creates + activates the conversation the proactive route targets, and
    // proves the live model answers before any pipeline assertions.
    await ensureThreadOpen(page);
    const composer = page.locator(CHAT_COMPOSER).first();
    await expect(composer).toBeVisible({ timeout: 60_000 });
    await composer.fill(
      "For an end-to-end test, reply with one short sentence: say hello.",
    );
    await page.locator(CHAT_SEND).first().click();
    await expect(
      page.locator(ASSISTANT_MESSAGE).filter({ hasText: /\S/ }).first(),
    ).toBeVisible({ timeout: 300_000 });

    // ── Persona steering through the real character API (see header note) ──
    const character = (await page.evaluate(async () => {
      const res = await fetch("/api/character");
      return res.json();
    })) as { character?: { system?: string } };
    const baseSystem = character.character?.system ?? "";
    expect(baseSystem.length).toBeGreaterThan(0);
    const steered = await page.evaluate(async (system) => {
      const res = await fetch("/api/character", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system }),
      });
      return res.ok;
    }, baseSystem + STEERED_PERSONA_SUFFIX);
    expect(steered, "PUT /api/character applied the persona").toBe(true);

    // Resolve the active conversation id for domain-artifact assertions.
    const conversationId = (await page.evaluate(async () => {
      const res = await fetch("/api/conversations");
      const data = (await res.json()) as {
        conversations?: Array<{ id: string }>;
      };
      return data.conversations?.[0]?.id ?? "";
    })) as string;
    expect(conversationId).not.toBe("");

    await shot(page, "01-chat-anchored.png");

    // Let the anchor turn's post-response processing fully drain: the decider
    // drops interactions while a chat turn is active (shouldSuppress reads
    // activeChatTurnCount), and a dropped interaction is never retried.
    await page.waitForTimeout(45_000);

    // ── Phase 1: real view switch → governed suggestion renders ────────────
    const surface1 = await switchViewViaPalette(page, "wallet", /wallet/i);
    // The suggestion lands in the active conversation over WS while the wallet
    // view is on screen; the transcript shows it when we return to chat.
    await expect(async () => {
      await backToChat(page);
      await expect(suggestionBubbles(page)).toHaveCount(1, {
        timeout: 5_000,
      });
    }).toPass({ timeout: SETTLE_DEBOUNCE_MS + JUDGE_WAIT_MS });
    const bubble = suggestionBubbles(page).first();
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText(/suggestion/i);
    const doItButton = bubble.getByRole("button", { name: "Do it" });
    const dismissButton = bubble.getByRole("button", {
      name: "Dismiss suggestion",
    });
    await expect(doItButton).toBeVisible();
    await expect(dismissButton).toBeVisible();
    await shot(page, "02-suggestion-rendered.png");

    // Domain artifact: the suggestion is a persisted agent memory with
    // source "proactive-interaction", not a transient frontend construct.
    const persisted = await fetchProactiveMessages(page, conversationId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].text.trim().length).toBeGreaterThan(0);

    // Mobile-viewport rendering of the same live suggestion (evidence).
    const desktopViewport = page.viewportSize() ?? {
      width: 1280,
      height: 720,
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bubble).toBeVisible();
    await shot(page, "03-suggestion-mobile.png");
    await page.setViewportSize(desktopViewport);
    await expect(bubble).toBeVisible();

    // ── Phase 2: immediate second switch is gate-suppressed (cooldown) ─────
    // Within the 2 min global cooldown of admission #1: the judge runs for the
    // fresh surface, but tryAdmit must reject with "global cooldown".
    const surface2 = await switchViewViaPalette(page, "calendar", /calendar/i);
    expect(surface2).not.toBe(surface1);
    await backToChat(page);
    // Watch long enough for the suppressed switch's judge round-trip to have
    // finished either way; the bubble count must never reach 2.
    const watchUntil = Date.now() + SUPPRESSION_WATCH_MS;
    while (Date.now() < watchUntil) {
      expect(await suggestionBubbles(page).count()).toBeLessThanOrEqual(1);
      await page.waitForTimeout(2_000);
    }
    expect(await fetchProactiveMessages(page, conversationId)).toHaveLength(1);
    await shot(page, "04-rate-limit-no-second-bubble.png");

    // ── Phase 3: dismiss removes the bubble ────────────────────────────────
    await dismissButton.click();
    await expect(suggestionBubbles(page)).toHaveCount(0, { timeout: 10_000 });
    await shot(page, "05-after-dismiss.png");

    // ── Phase 4: after the cooldown a fresh surface admits again; accept ───
    await page.waitForTimeout(
      Math.max(0, GLOBAL_COOLDOWN_MS - SUPPRESSION_WATCH_MS) + 10_000,
    );
    const surface3 = await switchViewViaPalette(page, "todo", /todo/i);
    expect(surface3).not.toBe(surface1);
    expect(surface3).not.toBe(surface2);
    await expect(async () => {
      await backToChat(page);
      await expect(suggestionBubbles(page)).toHaveCount(1, {
        timeout: 5_000,
      });
    }).toPass({ timeout: SETTLE_DEBOUNCE_MS + JUDGE_WAIT_MS });
    const secondBubble = suggestionBubbles(page).first();
    const secondOffer = (await secondBubble.textContent()) ?? "";
    await shot(page, "06-second-suggestion.png");

    const priorAssistantCount = await page
      .locator(ASSISTANT_MESSAGE)
      .filter({ hasText: /\S/ })
      .count();
    await secondBubble.getByRole("button", { name: "Do it" }).click();
    // Accept sends the real turn and clears the bubble.
    await expect(suggestionBubbles(page)).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page
        .locator(USER_MESSAGE)
        .filter({ hasText: "Yes, let's do it." })
        .last(),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, "07-accept-sent.png");
    // The live agent answers the accepted offer (a full real chat turn).
    await expect(
      page.locator(ASSISTANT_MESSAGE).filter({ hasText: /\S/ }),
    ).toHaveCount(priorAssistantCount + 1, { timeout: 300_000 });
    await shot(page, "08-accept-agent-replied.png");

    // ── Phase 5: the real Off control kills the pipeline pre-judge ─────────
    await openAppPath(page, "/settings");
    await openSettingsSection(page, /Capabilities/);
    const proactiveControl = page.getByTestId(
      "capability-proactive-suggestions",
    );
    await expect(proactiveControl).toBeVisible({ timeout: 20_000 });
    const configWrite = page.waitForResponse(
      (res) =>
        res.request().method() === "PUT" &&
        /\/api\/config(?:\?|$)/.test(res.url()) &&
        res.ok(),
      { timeout: 20_000 },
    );
    await proactiveControl.locator('button[data-value="off"]').click();
    await configWrite;
    await shot(page, "09-setting-off.png");

    // Wait out the remaining global cooldown so a suppressed switch can only
    // be attributed to the Off kill-switch, not the gate.
    await page.waitForTimeout(GLOBAL_COOLDOWN_MS + 10_000);
    const surface4 = await switchViewViaPalette(page, "inbox", /inbox/i);
    expect([surface1, surface2, surface3]).not.toContain(surface4);
    await openAppPath(page, "/chat");
    await ensureThreadOpen(page);
    // The reload above rehydrates past (persisted) suggestions from history —
    // dismissal is local-only by design — so assert on the DELTA: the bubble
    // count must not grow, and no new memory may be persisted.
    const baselineBubbles = await suggestionBubbles(page).count();
    const offWatchUntil = Date.now() + 30_000;
    while (Date.now() < offWatchUntil) {
      expect(await suggestionBubbles(page).count()).toBeLessThanOrEqual(
        baselineBubbles,
      );
      await page.waitForTimeout(2_000);
    }
    const finalPersisted = await fetchProactiveMessages(page, conversationId);
    expect(finalPersisted).toHaveLength(2);
    await shot(page, "10-off-no-suggestion.png");

    // ── Evidence dump ───────────────────────────────────────────────────────
    writeFileSync(
      path.join(OUT, "frontend-console.log"),
      consoleLog.join("\n"),
    );
    writeFileSync(
      path.join(OUT, "frontend-network.log"),
      netLog.map((e) => `[${e.t}] ${e.kind}: ${e.detail}`).join("\n"),
    );
    writeFileSync(
      path.join(OUT, "run-summary.json"),
      JSON.stringify(
        {
          surfaces: [surface1, surface2, surface3, surface4],
          firstSuggestion: persisted[0],
          secondSuggestion: secondOffer,
          persistedProactiveMessages: finalPersisted,
        },
        null,
        2,
      ),
    );
  });
});
