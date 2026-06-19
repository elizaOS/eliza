// Deep vault secrets round-trip against the REAL live stack.
//
// The keyless ui-smoke stub (playwright-ui-smoke-api-stub.mjs) cannot honor this
// flow: its `GET /api/secrets/inventory` always returns `[]` and its PUT does not
// persist, so a write→reload→read-back never converges. This spec therefore
// exploits the real app-core runtime + on-disk vault (ELIZA_UI_SMOKE_LIVE_STACK=1)
// and is classified LIVE_ONLY. It NEVER stubs the route under test — the secrets
// inventory PUT/GET/DELETE hit the real backend, which is the whole point.
//
// Flow: open the Vault modal → Secrets tab → add E2E_SMOKE_KEY → assert the real
// PUT 200 → row appears → reveal (real GET) shows the value → close+reopen →
// row persists → delete (real DELETE) → row gone. The unique E2E_* key namespace
// keeps the run isolated and the trailing delete cleans up the created secret.

import { expect, type Page, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

const SECRET_KEY = "E2E_SMOKE_KEY";
const SECRET_VALUE = "e2e-smoke-secret-value-7e3a";

const INVENTORY_KEY_RE = new RegExp(
  `/api/secrets/inventory/${SECRET_KEY}(?:\\?|$)`,
);

function countSecretWrites(page: Page): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (req.method() === "PUT" && INVENTORY_KEY_RE.test(req.url())) n += 1;
  });
  return () => n;
}

async function openVaultModal(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  // Global chord opens the secrets-manager modal (useSecretsManagerShortcut).
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(page.getByTestId("vault-tab-overview")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("vault-tab-secrets").click();
  await expect(page.getByTestId("vault-tab-secrets-content")).toBeVisible({
    timeout: 10_000,
  });
}

async function closeVaultModal(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("vault-tab-overview")).toHaveCount(0, {
    timeout: 10_000,
  });
}

test.describe("vault modal deep secret round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real on-disk vault (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub returns a static empty inventory and does not persist PUTs.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
  });

  test("adds, reveals, persists, and deletes a vault secret end to end", async ({
    page,
  }) => {
    const secretWrites = countSecretWrites(page);
    await openVaultModal(page);

    // Best-effort cleanup of any leftover from a prior aborted run so the add
    // round-trip starts from a known-absent state.
    const existing = page.getByTestId(`vault-entry-row-${SECRET_KEY}`);
    if (await existing.isVisible().catch(() => false)) {
      page.once("dialog", (dialog) => void dialog.accept());
      await existing
        .getByRole("button", { name: `Delete ${SECRET_KEY}` })
        .click();
      await expect(existing).toHaveCount(0, { timeout: 10_000 });
    }

    // Add the secret through the real form.
    await page.getByTestId("vault-add-secret").click();
    const form = page.getByTestId("vault-add-secret-form");
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form
      .locator('[data-agent-id="vault-add-key"]')
      .first()
      .fill(SECRET_KEY);
    await form
      .locator('[data-agent-id="vault-add-value"]')
      .first()
      .fill(SECRET_VALUE);
    await form
      .getByRole("button", { name: /Save secret/i })
      .first()
      .click();

    // Real PUT /api/secrets/inventory/E2E_SMOKE_KEY → 200, then the modal
    // re-fetches the inventory and the new row shows up.
    await expect.poll(secretWrites).toBeGreaterThan(0);
    const row = page.getByTestId(`vault-entry-row-${SECRET_KEY}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Reveal goes through the real GET /api/secrets/inventory/:key and shows the
    // value we just wrote.
    await row.getByRole("button", { name: `Reveal ${SECRET_KEY}` }).click();
    const revealed = page.getByTestId(`vault-revealed-${SECRET_KEY}`);
    await expect(revealed).toBeVisible({ timeout: 10_000 });
    await expect(revealed).toContainText(SECRET_VALUE);

    // Persistence: close + reopen the modal; the row survives because the value
    // is on the real backend, not in component state.
    await closeVaultModal(page);
    await openVaultModal(page);
    const persistedRow = page.getByTestId(`vault-entry-row-${SECRET_KEY}`);
    await expect(persistedRow).toBeVisible({ timeout: 15_000 });

    // Delete goes through the real DELETE /api/secrets/inventory/:key and the row
    // disappears after the modal re-fetches.
    page.once("dialog", (dialog) => void dialog.accept());
    await persistedRow
      .getByRole("button", { name: `Delete ${SECRET_KEY}` })
      .click();
    await expect(persistedRow).toHaveCount(0, { timeout: 15_000 });

    // Read-back after delete: reopen once more, confirm the key is truly gone.
    await closeVaultModal(page);
    await openVaultModal(page);
    await expect(page.getByTestId(`vault-entry-row-${SECRET_KEY}`)).toHaveCount(
      0,
      { timeout: 15_000 },
    );
  });
});
