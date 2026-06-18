// Deep wallet-key round-trip against the REAL live stack.
//
// Settings → Wallet & RPC → Wallet keys is backed by the same
// /api/secrets/inventory endpoints as the Vault tab, scoped to the wallet
// category. The keyless stub returns a fixed wallet inventory (EVM/SOLANA) and
// does not persist PUT/DELETE, so an add→reload→read-back→delete round-trip never
// converges there. This spec exploits the real app-core runtime + on-disk vault
// (ELIZA_UI_SMOKE_LIVE_STACK=1) and is classified LIVE_ONLY. It NEVER stubs the
// route under test — the inventory PUT/GET/DELETE hit the real backend.
//
// Flow: Wallet & RPC → Add wallet key (E2E_WALLET_KEY) → real PUT 200 → row
// appears → reveal (real GET) shows the value → delete (real DELETE) → row gone.
// The unique E2E_* key and trailing delete keep the live vault clean.

import { expect, test } from "@playwright/test";
import { openAppPath, openSettingsSection, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

const WALLET_KEY = "E2E_WALLET_KEY";
const WALLET_VALUE =
  "0xe2e0000000000000000000000000000000000000000000000000000000005m0ke";

test.describe("wallet keys deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real on-disk vault (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub returns a fixed wallet inventory and does not persist PUT/DELETE.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
  });

  test("adds, reveals, and deletes a wallet key end to end", async ({
    page,
  }) => {
    let inventoryWrites = 0;
    let inventoryDeletes = 0;
    const keyPathRe = new RegExp(
      `/api/secrets/inventory/${WALLET_KEY}(?:\\?|$)`,
    );
    page.on("request", (req) => {
      if (!keyPathRe.test(req.url())) return;
      if (req.method() === "PUT") inventoryWrites += 1;
      if (req.method() === "DELETE") inventoryDeletes += 1;
    });

    await openAppPath(page, "/settings");
    await openSettingsSection(page, /Wallet & RPC/);
    const section = page.getByTestId("wallet-keys-section");
    await expect(section).toBeVisible({ timeout: 30_000 });

    // Clean any residue from a prior aborted run.
    const existing = page.getByTestId(`wallet-keys-delete-${WALLET_KEY}`);
    if (await existing.isVisible().catch(() => false)) {
      page.once("dialog", (dialog) => void dialog.accept());
      await existing.click();
      await expect(existing).toHaveCount(0, { timeout: 10_000 });
    }

    // Add the wallet key through the real form.
    await section.getByTestId("wallet-keys-add-toggle").click();
    const form = section.getByTestId("wallet-keys-add-form");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form
      .locator('[data-agent-id="wallet-keys-key-name"]')
      .fill(WALLET_KEY);
    await form
      .locator('[data-agent-id="wallet-keys-private-key"]')
      .fill(WALLET_VALUE);
    await form.getByTestId("wallet-keys-save").click();

    // Real PUT /api/secrets/inventory/E2E_WALLET_KEY (category=wallet) → 200, then
    // the section reloads its wallet inventory and the row shows up.
    await expect.poll(() => inventoryWrites).toBeGreaterThan(0);
    const revealButton = page.getByTestId(`wallet-keys-reveal-${WALLET_KEY}`);
    await expect(revealButton).toBeVisible({ timeout: 15_000 });

    // Reveal goes through the real GET /api/secrets/inventory/:key and surfaces
    // the masked value (12+ char keys render as a 6…4 mask) in the row.
    await revealButton.click();
    const row = page
      .getByTestId("wallet-keys-list")
      .locator("li")
      .filter({ has: page.getByTestId(`wallet-keys-reveal-${WALLET_KEY}`) });
    await expect(row).toContainText(
      `${WALLET_VALUE.slice(0, 6)}…${WALLET_VALUE.slice(-4)}`,
      { timeout: 10_000 },
    );

    // Delete goes through the real DELETE /api/secrets/inventory/:key; after the
    // section reloads, the row is gone.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId(`wallet-keys-delete-${WALLET_KEY}`).click();
    await expect.poll(() => inventoryDeletes).toBeGreaterThan(0);
    await expect(
      page.getByTestId(`wallet-keys-reveal-${WALLET_KEY}`),
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
