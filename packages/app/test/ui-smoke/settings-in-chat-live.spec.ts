// Live-stack proof of the settings-in-chat round trip (#16939): a real
// LLM-backed agent emits a `[CONFIG:<pluginId>]` marker into the real chat
// surface (ChatOverlay), the rendered InlinePluginConfig card is edited, a
// save is driven through the real PUT /api/plugins/:id pipeline, the persisted
// config is re-read from the server as the domain artifact, and the
// enable/disable toggle runs the same mutation the Plugins page uses. The
// save-failure leg aborts one PUT at the network layer to prove the card
// renders its designed error state (UI three-state rule) instead of a
// healthy-empty render.
//
// Opt-in like live-agent-chat.spec.ts: ELIZA_UI_SMOKE_LIVE_STACK=1 plus a
// provider accepted by selectLiveProviderAsync(). Screenshots (JPG) and the
// frontend console/network logs land in ELIZA_SETTINGS_CARD_EVIDENCE_DIR when
// set (test-results output otherwise) for inline attachment to the issue/PR.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { selectLiveProviderAsync } from "../../../app-core/test/helpers/live-provider";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE_STACK_ENABLED = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const LIVE_PROVIDER = await selectLiveProviderAsync();
const EVIDENCE_DIR = process.env.ELIZA_SETTINGS_CARD_EVIDENCE_DIR?.trim() || "";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';

// Mirrors the settings-in-chat-config-card scenario prompt: ask for the
// connector's configuration without naming the marker syntax, so the emission
// is the model's own routing decision, not dictation.
const CONFIG_CARD_PROMPT =
  "I want to set up the telegram connector — show me its configuration right here in chat.";

// Distinctive non-secret placeholder so the persisted-config assertion can
// recognize OUR write (Telegram bot tokens are `<digits>:<hash>` shaped; this
// value is syntactically plausible but deliberately fake).
const E2E_TOKEN_VALUE = "1234567890:E2E-LIVE-SETTINGS-CARD-PROOF";

type CapturedLogs = {
  console: string[];
  network: string[];
  failures: string[];
};

function collectLogs(page: Page): CapturedLogs {
  const logs: CapturedLogs = { console: [], network: [], failures: [] };
  page.on("console", (message) => {
    logs.console.push(`[${message.type()}] ${message.text()}`);
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^\[RenderTelemetry\]/.test(text)) return;
    // Optional live endpoints 401/404 on a lean stack (same allowance as
    // live-agent-chat.spec.ts); 5xx and app errors still fail the run.
    if (
      /^Failed to load resource: the server responded with a status of (401|404) /i.test(
        text,
      )
    ) {
      return;
    }
    // The save-failure leg aborts exactly one PUT at the network layer on
    // purpose; the browser logs that induced abort as a resource error.
    if (/^Failed to load resource: net::ERR_CONNECTION_FAILED/i.test(text)) {
      return;
    }
    logs.failures.push(`console.error: ${text}`);
  });
  page.on("pageerror", (error) => {
    logs.failures.push(`pageerror: ${error.message}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!/\/api\//.test(url)) return;
    logs.network.push(
      `${response.request().method()} ${url} -> ${response.status()}`,
    );
  });
  return logs;
}

function evidencePath(name: string): string | null {
  if (!EVIDENCE_DIR) return null;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, name);
}

async function snap(page: Page, name: string): Promise<void> {
  const file = evidencePath(name);
  if (!file) return;
  await page.screenshot({
    path: file,
    type: "jpeg",
    quality: 82,
    fullPage: false,
  });
}

function writeEvidenceLogs(prefix: string, logs: CapturedLogs): void {
  const consoleFile = evidencePath(`${prefix}-console.log`);
  if (consoleFile) writeFileSync(consoleFile, logs.console.join("\n"));
  const networkFile = evidencePath(`${prefix}-network.log`);
  if (networkFile) writeFileSync(networkFile, logs.network.join("\n"));
}

/**
 * Opens the chat surface and lets the boot flow settle. Deliberately does NOT
 * pre-seed an active conversation id: on a cold live stack the first-run flow
 * creates its own greeting conversation and switches to it, so a pre-seeded id
 * sends the prompt into an invisible thread (observed live: the stream POST
 * returned 200 into a conversation the overlay never displayed). Sending into
 * whatever conversation the UI actually has active is what a real user does.
 */
async function openChatSurface(page: Page): Promise<void> {
  await seedAppStorage(page);
  await openAppPath(page, "/chat");
  await expect(page.locator(CHAT_COMPOSER_SELECTOR).first()).toBeVisible({
    timeout: 120_000,
  });
  // A cold stack's first load runs a conversation bootstrap (create + preview
  // transcript) concurrently with anything the test sends; a send racing that
  // bootstrap can land in a conversation the overlay then navigates away from
  // (observed twice: stream POST 200 into a thread the overlay never showed).
  // Wait until the server-side conversation list is non-empty and stable
  // across two polls, then reload so the overlay adopts the settled active
  // conversation before the test types anything.
  let previous = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await page.request.get("/api/conversations");
    const body = (await response.json().catch(() => ({}))) as {
      conversations?: Array<{ id?: string }>;
    };
    const ids = (body.conversations ?? [])
      .map((conversation) => conversation.id ?? "")
      .sort()
      .join(",");
    if (ids && ids === previous) break;
    previous = ids;
    await page.waitForTimeout(2_000);
  }
  await openAppPath(page, "/chat");
  await expect(page.locator(CHAT_COMPOSER_SELECTOR).first()).toBeVisible({
    timeout: 120_000,
  });
}

/**
 * Sends the config-card prompt and waits for the rendered card. The very
 * first model turn on a cold stack can fail transiently and surface the
 * runtime's designed failure reply ("…mind trying again in a moment?") —
 * correct product behavior (fail visibly, invite retry). Doing what that
 * reply asks, the helper retries the prompt once; a second failure fails the
 * test.
 */
async function promptForConfigCard(page: Page): Promise<void> {
  const card = page.getByTestId("inline-plugin-config").last();
  const failureReplies = page.getByText(
    /glitched|something went wrong|try(ing)? again in a moment/i,
  );
  const prompts = page.getByText(/set up the telegram connector/i);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Prior turns stay in the transcript, so a retry must count NEW failure
    // replies / prompt bubbles rather than re-matching the stale ones.
    const failuresBefore = await failureReplies.count();
    const promptsBefore = await prompts.count();
    const composer = page.locator(CHAT_COMPOSER_SELECTOR).first();
    await composer.fill(CONFIG_CARD_PROMPT);
    await expect(page.locator(CHAT_SEND_SELECTOR).first()).toBeEnabled();
    await page.locator(CHAT_SEND_SELECTOR).first().click();
    // The send must land in the VISIBLE conversation before the model turn is
    // awaited — a green stream POST into a hidden thread must fail here, not
    // as a widget-render timeout.
    await expect
      .poll(async () => prompts.count(), {
        timeout: 30_000,
        message: "the sent prompt should appear in the visible transcript",
      })
      .toBeGreaterThan(promptsBefore);
    // The live model turn: [CONFIG:telegram] must arrive and the transcript
    // must lift it into the InlinePluginConfig widget shell — or the runtime's
    // failure reply shows up and earns exactly one retry.
    await expect
      .poll(
        async () => {
          if (await card.isVisible().catch(() => false)) return "card";
          if ((await failureReplies.count()) > failuresBefore) return "failure";
          return "pending";
        },
        {
          timeout: 180_000,
          message:
            "the model turn should produce the config card (or the designed failure reply)",
        },
      )
      .not.toBe("pending");
    if (await card.isVisible().catch(() => false)) return;
  }
  await expect(
    card,
    "the [CONFIG:…] marker should render as the inline plugin-config card",
  ).toBeVisible({ timeout: 1_000 });
}

/**
 * Reveals the token form when the card defaults to an OAuth-style mode, then
 * returns the card's first config input.
 */
async function revealConfigForm(page: Page) {
  const card = page.getByTestId("inline-plugin-config").last();
  const useApiKey = page.getByTestId("inline-plugin-config-use-apikey");
  if (await useApiKey.isVisible().catch(() => false)) {
    await useApiKey.click();
  }
  const input = card.locator("input[data-config-key]").first();
  await expect(
    input,
    "the card should render an editable config field",
  ).toBeVisible({ timeout: 30_000 });
  return input;
}

test.describe("settings-in-chat live round trip", () => {
  test.skip(
    !LIVE_STACK_ENABLED,
    "set ELIZA_UI_SMOKE_LIVE_STACK=1 to run against the real app runtime",
  );
  test.skip(
    !LIVE_PROVIDER,
    "set a supported live provider key for the app runtime",
  );

  test("chat overlay renders the CONFIG card; edit → failed save shows the error state → save persists → enable/disable round-trips", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const logs = collectLogs(page);
    await openChatSurface(page);

    await promptForConfigCard(page);
    await snap(page, "01-desktop-card-rendered.jpg");

    const input = await revealConfigForm(page);
    const configKey = await input.getAttribute("data-config-key");
    expect(configKey, "config field key").toBeTruthy();
    await input.fill(E2E_TOKEN_VALUE);
    await snap(page, "02-desktop-card-edited.jpg");

    const card = page.getByTestId("inline-plugin-config").last();
    const saveButton = card.getByRole("button", { name: /^sav(e|ing)/i });

    // Error leg first: abort exactly one PUT at the transport layer and prove
    // the card renders its designed error state — never a healthy-empty or
    // silent render (UI three-state rule). The abort simulates a real network
    // drop; the app pipeline under test is entirely real.
    let aborted = false;
    await page.route("**/api/plugins/**", async (route) => {
      if (!aborted && route.request().method() === "PUT") {
        aborted = true;
        await route.abort("connectionfailed");
        return;
      }
      await route.fallback();
    });
    await saveButton.click();
    await expect(
      card.locator(".text-danger").first(),
      "a failed save must surface the card's error state",
    ).toBeVisible({ timeout: 30_000 });
    await snap(page, "03-desktop-card-save-error-state.jpg");
    await page.unroute("**/api/plugins/**");

    // Success leg: the same click drives the real PUT /api/plugins/:id.
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/api\/plugins\/[^/]+$/.test(response.url()) &&
          response.request().method() === "PUT",
        { timeout: 60_000 },
      ),
      saveButton.click(),
    ]);
    expect(
      saveResponse.ok(),
      `PUT ${saveResponse.url()} should succeed (status=${saveResponse.status()})`,
    ).toBe(true);
    const pluginId = decodeURIComponent(
      new URL(saveResponse.url()).pathname.split("/").pop() ?? "",
    );
    expect(pluginId, "plugin id from the save PUT").toBeTruthy();
    await expect(card.getByText(/^saved$/i)).toBeVisible({ timeout: 30_000 });
    await snap(page, "04-desktop-card-saved.jpg");

    // Domain artifact: re-read the server's plugin state — the saved key must
    // be reflected as configured (never asserted from the client's own state).
    const pluginsResponse = await page.request.get("/api/plugins");
    expect(pluginsResponse.ok()).toBe(true);
    const plugins = (await pluginsResponse.json()) as {
      plugins?: Array<{
        id?: string;
        configured?: boolean;
        enabled?: boolean;
        config?: Record<string, unknown>;
      }>;
    };
    const saved = plugins.plugins?.find((entry) => entry.id === pluginId);
    expect(saved, `plugin ${pluginId} in /api/plugins after save`).toBeTruthy();
    expect(
      saved?.configured,
      `plugin ${pluginId} should report configured=true after the card save`,
    ).toBe(true);

    // Enable → the exact PluginsView mutation; the card collapses to its
    // connected summary. Then disable to leave the shared stack clean.
    const enableButton = card.getByRole("button", {
      name: /enable plugin|turning on/i,
    });
    const [enableResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes(`/api/plugins/`) &&
          response.request().method() === "PUT",
        { timeout: 60_000 },
      ),
      enableButton.click(),
    ]);
    expect(enableResponse.ok()).toBe(true);
    await expect(
      card.getByText(/is enabled\./i),
      "enabling collapses the card to its connected summary",
    ).toBeVisible({ timeout: 60_000 });
    await snap(page, "05-desktop-card-enabled-summary.jpg");

    const disableResponse = await page.request.put(`/api/plugins/${pluginId}`, {
      data: { enabled: false },
    });
    expect(disableResponse.ok()).toBe(true);

    writeEvidenceLogs("desktop", logs);
    expect(logs.failures, "browser/runtime failures").toEqual([]);
  });
});

test.describe("settings-in-chat live round trip (mobile viewport)", () => {
  test.skip(
    !LIVE_STACK_ENABLED,
    "set ELIZA_UI_SMOKE_LIVE_STACK=1 to run against the real app runtime",
  );
  test.skip(
    !LIVE_PROVIDER,
    "set a supported live provider key for the app runtime",
  );
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("mobile chat overlay renders the CONFIG card and saves through the real pipeline", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    const logs = collectLogs(page);
    await openChatSurface(page);

    await promptForConfigCard(page);
    await snap(page, "06-mobile-card-rendered.jpg");

    const input = await revealConfigForm(page);
    await input.fill(E2E_TOKEN_VALUE);
    const card = page.getByTestId("inline-plugin-config").last();
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/api\/plugins\/[^/]+$/.test(response.url()) &&
          response.request().method() === "PUT",
        { timeout: 60_000 },
      ),
      card.getByRole("button", { name: /^sav(e|ing)/i }).click(),
    ]);
    expect(saveResponse.ok()).toBe(true);
    await expect(card.getByText(/^saved$/i)).toBeVisible({ timeout: 30_000 });
    await snap(page, "07-mobile-card-saved.jpg");

    writeEvidenceLogs("mobile", logs);
    expect(logs.failures, "browser/runtime failures").toEqual([]);
  });
});
