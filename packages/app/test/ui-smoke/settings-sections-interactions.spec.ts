/**
 * Exercises Settings controls in the renderer fixture and isolated real API.
 * Keyless cases prove dispatch or local state only; real-local Wallet cases
 * require exact request outcomes and disk reload before accepting persistence.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:developerMode": "1" });
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

test("general settings: selecting a language updates the active value", async ({
  page,
}) => {
  // The app ships a single curated light look (no dark/light/system toggle).
  // General exposes the language picker; selecting an option must update the
  // visible controlled value.
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^General$/);
  await expect(page.locator("#appearance")).toBeVisible({ timeout: 30_000 });

  const language = page.locator('[data-agent-id="general-language"]').first();
  await expect(language).toBeVisible({ timeout: 15_000 });
  await expect(language).toContainText("English");
  await language.click();
  await page.getByRole("option", { name: /Español/ }).click();
  await expect(language).toContainText("Español", { timeout: 10_000 });
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

test("capabilities settings: the Wallet switch dispatches its config patch", async ({
  page,
}) => {
  // Repointed from a local-only aria-checked flip (which proved nothing about
  // the backend) to the real pipeline: toggling the Wallet capability calls
  // client.updateConfig({ ui: { capabilities: { wallet } } }) → PUT /api/config.
  // We do NOT stub /api/config; the request hits the real backend (stub in
  // keyless CI, app runtime under the live stack). Asserting the request
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

test.describe("Wallet capability persisted effects", () => {
  test.skip(
    process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK !== "1",
    "requires the isolated real-local API/config file; fixture responses cannot prove persistence",
  );

  async function reloadConfig(page: Page): Promise<unknown> {
    const reload = await page.request.post("/api/config/reload");
    expect(reload.status()).toBe(200);
    expect(await reload.json()).toMatchObject({ reloaded: true });
    const read = await page.request.get("/api/config");
    expect(read.status()).toBe(200);
    return read.json();
  }

  function uiConfiguration(config: unknown): unknown {
    if (typeof config !== "object" || config === null || !("ui" in config)) {
      throw new Error("The real config response is missing its UI settings");
    }
    return config.ui;
  }

  async function openWalletSettings(page: Page): Promise<void> {
    await openAppPath(page, "/settings");
    await openSettingsSection(page, /Capabilities/);
    await expect(
      page.locator('[data-agent-id="capability-wallet"]'),
    ).toBeVisible();
  }

  test.beforeEach(async ({ page }) => {
    // Remove only the static config GET fixture. Both browser reads and writes
    // now reach the production handler backed by this stack's temporary file.
    await page.unroute("**/api/config");
    const seed = await page.request.put("/api/config", {
      data: { ui: { capabilities: { wallet: false } } },
    });
    expect(seed.status()).toBe(200);
    expect(await reloadConfig(page)).toMatchObject({
      ui: { capabilities: { wallet: false } },
    });
  });

  test("saves the clicked value and restores it from disk after navigation", async ({
    page,
  }) => {
    await openWalletSettings(page);
    const wallet = page.locator('[data-agent-id="capability-wallet"]');
    await expect(wallet).toHaveAttribute("aria-checked", "false");
    const saved = page.waitForResponse((response) => {
      const request = response.request();
      return (
        new URL(response.url()).pathname === "/api/config" &&
        request.method() === "PUT" &&
        request.postData() ===
          JSON.stringify({ ui: { capabilities: { wallet: true } } })
      );
    });
    await wallet.click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      ui: { capabilities: { wallet: true } },
    });
    expect(await reloadConfig(page)).toMatchObject({
      ui: { capabilities: { wallet: true } },
    });
    await openWalletSettings(page);
    await expect(wallet).toHaveAttribute("aria-checked", "true");
  });

  test("a real validation rejection cannot change the persisted value", async ({
    page,
  }) => {
    const before = uiConfiguration(await reloadConfig(page));
    await openWalletSettings(page);
    const wallet = page.locator('[data-agent-id="capability-wallet"]');
    await expect(wallet).toHaveAttribute("aria-checked", "false");
    let forwarded = false;
    // Corrupt only this browser write on the wire. Do not fulfill a fake error:
    // the owning API must parse and reject it, and its disk state must survive.
    await page.route("**/api/config", async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      expect(route.request().postDataJSON()).toEqual({
        ui: { capabilities: { wallet: true } },
      });
      forwarded = true;
      await route.continue({ postData: "{" });
    });
    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/config" &&
        response.request().method() === "PUT",
    );
    await wallet.click();
    expect((await rejected).status()).toBe(400);
    expect(forwarded).toBe(true);
    await expect(
      page.getByText(
        "Failed to sync wallet setting to the agent — it may revert on reload",
        { exact: true },
      ),
    ).toBeVisible();
    await page.unroute("**/api/config");
    // The background version checker owns separate update metadata. Compare
    // every UI setting, so unrelated checks cannot mask or invent a mutation.
    expect(uiConfiguration(await reloadConfig(page))).toEqual(before);
    await openWalletSettings(page);
    await expect(wallet).toHaveAttribute("aria-checked", "false");
  });
});

test("backup settings: Back Up opens its modal", async ({ page }) => {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Backups$/);
  await expect(page.locator("#advanced")).toBeVisible({ timeout: 30_000 });

  await page.locator('[data-agent-id="advanced-export-open"]').first().click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
});

// Deep character round-trip against the REAL backend. Personality now renders
// inline and autosaves after a 700 ms debounce; there is no open step or manual
// Save button. The shared client and app route currently use PUT for the
// partial character edit. This test observes a successful real response and
// proves write→reload→read-back persistence. LIVE_ONLY: the keyless stub cannot
// persist a character edit.
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
    page.on("response", (res) => {
      const req = res.request();
      if (
        req.method() === "PUT" &&
        /\/api\/character(?:\?|$)/.test(req.url()) &&
        res.ok()
      ) {
        characterSaves += 1;
      }
    });

    const uniqueBio = `A concise smoke-test agent persona ${Date.now()}.`;

    await openAppPath(page, "/character");
    await expect(page.getByTestId("character-editor-view")).toBeVisible({
      timeout: 60_000,
    });

    const bio = page
      .locator('[data-agent-id="identity-bio"]')
      .or(page.getByPlaceholder(/Describe who your agent is/i))
      .first();
    await expect(bio).toBeVisible({ timeout: 15_000 });
    await bio.fill(uniqueBio);

    // Real debounced PUT /api/character → 2xx — the backend handler runs and
    // persists before the read-back navigation begins.
    await expect.poll(() => characterSaves).toBeGreaterThan(0);

    // Read-back: reload the character editor and confirm the saved bio survives
    // (it came from the real backend, not component state).
    await openAppPath(page, "/character");
    await expect(page.getByTestId("character-editor-view")).toBeVisible({
      timeout: 60_000,
    });
    const reloadedBio = page
      .locator('[data-agent-id="identity-bio"]')
      .or(page.getByPlaceholder(/Describe who your agent is/i))
      .first();
    await expect(reloadedBio).toBeVisible({ timeout: 15_000 });
    await expect(reloadedBio).toHaveValue(uniqueBio, { timeout: 15_000 });
  });
});
