// Real interaction coverage for the Settings sections + character editor.
// all-pages-clicksafe only render-smokes settings; this drives the actual
// controls (voice wake-word toggle, appearance theme, capability switch, app-
// permission refresh, backup modal, character bio save) and asserts they
// DO something. Keyless against the stub.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

function countRequests(
  page: Page,
  predicate: (url: string, method: string) => boolean,
): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (predicate(req.url(), req.method())) n += 1;
  });
  return () => n;
}

test("voice settings: the wake-word toggle flips state", async ({ page }) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Voice$/);
  await expect(page.getByTestId("voice-section")).toBeVisible({
    timeout: 30_000,
  });

  const wakeWord = page.getByTestId("voice-section-wake-toggle");
  await expect(wakeWord).toBeVisible({ timeout: 15_000 });
  const before = await wakeWord.isChecked();
  await wakeWord.click();
  await expect.poll(() => wakeWord.isChecked()).toBe(!before);
});

test("appearance settings: selecting a language tile marks it active", async ({
  page,
}) => {
  // The app ships a single curated light look (no dark/light/system toggle).
  // Appearance now exposes the language tiles; selecting one is the real
  // "pick an option, it marks active via aria-current" interaction here.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Appearance/);
  await expect(page.locator("#appearance")).toBeVisible({ timeout: 30_000 });

  const english = page
    .locator('[data-agent-id="appearance-language-en"]')
    .first();
  const spanish = page
    .locator('[data-agent-id="appearance-language-es"]')
    .first();
  await expect(english).toBeVisible({ timeout: 15_000 });
  await expect(english).toHaveAttribute("aria-current", "true");
  await expect(spanish).not.toHaveAttribute("aria-current", "true");

  await spanish.click();
  await expect(spanish).toHaveAttribute("aria-current", "true", {
    timeout: 10_000,
  });
  await expect(english).not.toHaveAttribute("aria-current", "true");
});

test("background settings: wallpaper controls update the shared wallpaper", async ({
  page,
}) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Background$/);
  await expect(page.locator("#background")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Set background to Reef").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.localStorage.getItem("eliza:ui-background") ?? "",
      ),
    )
    .toContain("/wallpapers/reef.webp");
});

test("app-permissions settings: Refresh re-queries the app permissions", async ({
  page,
}) => {
  const permReqs = countRequests(page, (url) =>
    /\/api\/apps\/permissions(?:\?|$)/.test(url),
  );
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /App Permissions/);
  await expect(page.locator("#app-permissions")).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(permReqs).toBeGreaterThan(0);

  const before = permReqs();
  await page
    .locator("#app-permissions")
    .getByRole("button", { name: /refresh/i })
    .first()
    .click();
  await expect.poll(permReqs).toBeGreaterThan(before);
});

test("capabilities settings: the Wallet switch fires the real config write", async ({
  page,
}) => {
  // Repointed from a local-only aria-checked flip (which proved nothing about
  // the backend) to the real pipeline: toggling the Wallet capability calls
  // client.updateConfig({ ui: { capabilities: { wallet } } }) → PUT /api/config.
  // We do NOT stub /api/config; the request hits the real backend (stub in
  // keyless CI, app-core runtime under the live stack). Asserting the request
  // fired with the capability patch is the load-bearing, deterministic contract.
  // The local aria-checked flip is verified too, but it is no longer the point.
  const configWrites: Array<{ wallet: unknown }> = [];
  page.on("request", (req) => {
    if (req.method() !== "PUT") return;
    if (!/\/api\/config(?:\?|$)/.test(req.url())) return;
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    const wallet = (
      body as { ui?: { capabilities?: { wallet?: unknown } } } | null
    )?.ui?.capabilities?.wallet;
    if (wallet !== undefined) configWrites.push({ wallet });
  });

  await openAppPath(page, "/settings");
  await openSettingsSection(page, /Capabilities/);
  await expect(page.locator("#capabilities")).toBeVisible({ timeout: 30_000 });

  const walletSwitch = page.locator('[data-agent-id="capability-wallet"]');
  await expect(walletSwitch).toBeVisible({ timeout: 15_000 });
  const before = await walletSwitch.getAttribute("aria-checked");
  await walletSwitch.click();

  // Real PUT /api/config carrying the wallet capability patch.
  await expect.poll(() => configWrites.length).toBeGreaterThan(0);
  expect(configWrites.some((w) => typeof w.wallet === "boolean")).toBe(true);

  // The local toggle still flips so the user sees the change immediately.
  await expect
    .poll(() => walletSwitch.getAttribute("aria-checked"))
    .not.toBe(before);
});

test("backup settings: Back Up opens its modal", async ({ page }) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Backups$/);
  await expect(page.locator("#advanced")).toBeVisible({ timeout: 30_000 });

  await page.locator('[data-agent-id="advanced-export-open"]').first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
});

// Deep character round-trip against the REAL backend. The previous keyless
// version stubbed PUT /api/character via page.route so Save resolved — a LARP
// that proved the button fired a request but never that the edit persisted (the
// stub's GET /api/character returns a static character, so a reload would not
// reflect the new bio). This rewrite removes the stub entirely and does the real
// write→reload→read-back: it hits the live app-core runtime, which persists the
// character to the runtime + DB, so the reloaded editor shows the saved bio.
// LIVE_ONLY: the keyless stub cannot persist a character edit.
test.describe("character editor deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real character pipeline (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub serves a static GET /api/character and has no PUT handler.",
  );

  test("editing the bio saves through the real backend and persists on reload", async ({
    page,
  }) => {
    let characterSaves = 0;
    page.on("request", (req) => {
      if (
        req.method() === "PUT" &&
        /\/api\/character(?:\?|$)/.test(req.url())
      ) {
        characterSaves += 1;
      }
    });

    const uniqueBio = `A concise smoke-test agent persona ${Date.now()}.`;

    await openAppPath(page, "/character");
    await expect(page.getByTestId("character-editor-view")).toBeVisible({
      timeout: 60_000,
    });
    await page
      .getByRole("button", { name: /Open Personality/i })
      .first()
      .click();

    const bio = page
      .getByRole("textbox", { name: /About Me/i })
      .or(page.getByPlaceholder(/Describe who your agent is/i))
      .first();
    await expect(bio).toBeVisible({ timeout: 15_000 });
    await bio.fill(uniqueBio);

    const save = page.getByRole("button", { name: /^Save$/ }).first();
    await expect(save).toBeEnabled({ timeout: 10_000 });
    await save.click();

    // Real PUT /api/character — the backend handler runs and persists.
    await expect.poll(() => characterSaves).toBeGreaterThan(0);

    // Read-back: reload the character editor and confirm the saved bio survives
    // (it came from the real backend, not component state).
    await openAppPath(page, "/character");
    await expect(page.getByTestId("character-editor-view")).toBeVisible({
      timeout: 60_000,
    });
    await page
      .getByRole("button", { name: /Open Personality/i })
      .first()
      .click();
    const reloadedBio = page
      .getByRole("textbox", { name: /About Me/i })
      .or(page.getByPlaceholder(/Describe who your agent is/i))
      .first();
    await expect(reloadedBio).toBeVisible({ timeout: 15_000 });
    await expect(reloadedBio).toHaveValue(uniqueBio, { timeout: 15_000 });
  });
});
