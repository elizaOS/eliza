// Opt-in REAL cloud e2e: real login + real provisioning + real cloud chat,
// through the app UI, against real Eliza Cloud. This is the un-mocked counterpart
// to cloud-provisioning-startup.spec.ts (which asserts the UI against page.route
// fixtures). NOTHING here mocks a cloud endpoint — the requests hit the live
// stack, which proxies /api/cloud/* to real cloud-api.
//
// Requirements (all enforced by the skip guard below; the gated app-live-e2e.yml
// lane supplies them):
//   - ELIZA_UI_SMOKE_CLOUD_LIVE=1  → the live stack leaves first-run UNcompleted
//     so this spec can drive cloud onboarding through the UI.
//   - ELIZA_UI_SMOKE_LIVE_STACK=1  → the live stack boots the real app-core
//     runtime instead of the deterministic stub (shouldForceStubStack).
//   - ELIZAOS_CLOUD_API_KEY        → real cloud credential; the app treats cloud
//     as connected, so no interactive OAuth window is needed.
//
// It must NEVER run in a keyless PR lane: it spends real cloud credits and needs
// secrets. It is classified LIVE_ONLY in ui-smoke-coverage.test.ts and is wired
// only into the nightly/dispatch app-live-e2e.yml workflow.

import { expect, type Locator, type Page, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const CLOUD_LIVE_ENABLED =
  process.env.ELIZA_UI_SMOKE_CLOUD_LIVE === "1" &&
  process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
const HAS_CLOUD_KEY = Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim());

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';
const CHAT_SEND_SELECTOR =
  '[data-testid="chat-composer-action"], button[aria-label="Send"], button[aria-label="Send message"]';
// The deterministic stub tags every reply with this fixture id. A real cloud
// agent must NOT produce it — that is how we prove the turn was not a stub.
const STUB_FIXTURE_MARKER = "ui-smoke-assistant-v1";

const PROVISION_TIMEOUT_MS = 180_000;

function chatComposer(page: Page): Locator {
  return page.locator(CHAT_COMPOSER_SELECTOR).first();
}

function chatSendButton(page: Page): Locator {
  return page.locator(CHAT_SEND_SELECTOR).first();
}

async function clickIfVisible(
  locator: Locator,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    await locator.first().click();
    return true;
  } catch {
    return false;
  }
}

// Drive whichever cloud entry point the onboarding surface presents — the compact
// toast offers "Connect"/"Eliza Cloud"; the detailed shell offers the cloud card
// then a "Start"/"Connect" primary; both may show a "Sign in with Eliza Cloud".
async function chooseCloudRuntime(page: Page): Promise<void> {
  const cloudCard = page
    .getByTestId("first-run-runtime-cloud")
    .or(page.locator("button").filter({ hasText: /^Eliza Cloud$/ }));
  await clickIfVisible(cloudCard, 30_000);
  await clickIfVisible(
    page.getByRole("button", { name: /^(Start|Connect)$/ }),
    5_000,
  );
  await clickIfVisible(
    page.getByRole("button", { name: /sign in with eliza cloud/i }),
    5_000,
  );
}

async function readActiveServer(page: Page): Promise<{
  kind?: string;
  apiBase?: string;
} | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("elizaos:active-server");
    return raw
      ? (JSON.parse(raw) as { kind?: string; apiBase?: string })
      : null;
  });
}

test.describe("real cloud login + provisioning + chat", () => {
  test.skip(
    !CLOUD_LIVE_ENABLED,
    "set ELIZA_UI_SMOKE_CLOUD_LIVE=1 and ELIZA_UI_SMOKE_LIVE_STACK=1 to run against real Eliza Cloud",
  );
  test.skip(
    !HAS_CLOUD_KEY,
    "set ELIZAOS_CLOUD_API_KEY to authenticate to real Eliza Cloud",
  );

  test("provisions a real cloud agent from onboarding and chats with it", async ({
    page,
  }) => {
    await seedAppStorage(page, { "eliza:first-run-complete": "" });
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for any onboarding surface (compact toast or detailed shell).
    await expect(
      page
        .getByTestId("first-run-shell")
        .or(page.getByTestId("onboarding-toast"))
        .or(page.getByTestId("onboarding-overlay-shell")),
    ).toBeVisible({ timeout: 60_000 });

    await chooseCloudRuntime(page);

    // Real provisioning (create -> provision -> poll jobs -> launch) persists a
    // cloud active-server with the provisioned agent's bridge URL. This only
    // succeeds if real login + provisioning actually completed.
    await expect
      .poll(() => readActiveServer(page).then((s) => s?.kind ?? null), {
        timeout: PROVISION_TIMEOUT_MS,
      })
      .toBe("cloud");
    const active = await readActiveServer(page);
    expect(
      active?.apiBase,
      "provisioned cloud agent must expose a bridge URL",
    ).toBeTruthy();

    // Real chat turn against the provisioned cloud agent.
    await openAppPath(page, "/chat");
    const composer = chatComposer(page);
    await expect(composer).toBeVisible({ timeout: 60_000 });
    const prompt = "In one short sentence, say hello.";
    await composer.fill(prompt);
    await expect(chatSendButton(page)).toBeEnabled();
    await chatSendButton(page).click();

    const assistant = page
      .locator(
        '[data-role="assistant"], [data-testid="chat-message-assistant"]',
      )
      .last();
    await expect(assistant).toBeVisible({ timeout: 120_000 });
    const text = (await assistant.textContent())?.trim() ?? "";
    expect(
      text.length,
      "cloud agent must produce a non-empty reply",
    ).toBeGreaterThan(0);
    // Prove it was a real model turn, not the deterministic stub fixture.
    expect(text).not.toContain(STUB_FIXTURE_MARKER);
  });
});
