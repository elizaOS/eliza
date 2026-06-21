// Deep routing-config round-trip against the REAL live stack.
//
// The Routing tab is the single source of truth for `GET/PUT /api/secrets/routing`.
// The keyless stub's `GET /api/secrets/routing` always returns `{rules:[]}` and its
// PUT does not persist, so a save→reload→read-back never converges. This spec
// therefore exploits the real app-core runtime + on-disk vault
// (ELIZA_UI_SMOKE_LIVE_STACK=1) and is classified LIVE_ONLY. It NEVER stubs the
// route under test — `PUT /api/secrets/routing` hits the real backend.
//
// Flow: seed a vault key (E2E_ROUTING_KEY) → enable profiles (migrate) → add a
// second profile (work) so a non-default profile id exists → Routing tab → add a
// rule (agent scope, the work profile) via routing-add-rule-form → assert the real
// PUT /api/secrets/routing 200 → reopen the tab → the rule row persists. Cleanup
// deletes the rule and the seeded key so the live vault is left clean.

import { expect, type Page, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

const ROUTING_KEY = "E2E_ROUTING_KEY";
const ROUTING_VALUE = "e2e-routing-secret-c91f";
const PROFILE_ID = "work";

function countRoutingWrites(page: Page): () => number {
  let n = 0;
  page.on("response", (res) => {
    const req = res.request();
    if (
      req.method() === "PUT" &&
      /\/api\/secrets\/routing(?:\?|$)/.test(req.url()) &&
      res.status() === 200
    ) {
      n += 1;
    }
  });
  return () => n;
}

async function openVaultModal(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("Control+Alt+Shift+V");
  await expect(page.getByTestId("vault-tab-overview")).toBeVisible({
    timeout: 20_000,
  });
}

async function closeVaultModal(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("vault-tab-overview")).toHaveCount(0, {
    timeout: 10_000,
  });
}

async function gotoSecretsTab(page: Page): Promise<void> {
  await page.getByTestId("vault-tab-secrets").click();
  await expect(page.getByTestId("vault-tab-secrets-content")).toBeVisible({
    timeout: 10_000,
  });
}

async function gotoRoutingTab(page: Page): Promise<void> {
  await page.getByTestId("vault-tab-routing").click();
  await expect(page.getByTestId("routing-tab")).toBeVisible({
    timeout: 10_000,
  });
}

async function deleteSeedKeyIfPresent(page: Page): Promise<void> {
  await gotoSecretsTab(page);
  const row = page.getByTestId(`vault-entry-row-${ROUTING_KEY}`);
  if (await row.isVisible().catch(() => false)) {
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: `Delete ${ROUTING_KEY}` }).click();
    await expect(row).toHaveCount(0, { timeout: 10_000 });
  }
}

test.describe("vault routing deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real on-disk vault (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub serves a static empty routing config and does not persist PUTs.",
  );

  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page);
  });

  test("adds a routing rule and persists it across a tab reopen", async ({
    page,
  }) => {
    const routingWrites = countRoutingWrites(page);
    await openVaultModal(page);

    // Clean any residue from a prior aborted run.
    await deleteSeedKeyIfPresent(page);

    // Seed a key, then enable profiles + add a non-default profile so the rule
    // form has a profile to bind to.
    await page.getByTestId("vault-add-secret").click();
    const addForm = page.getByTestId("vault-add-secret-form");
    await expect(addForm).toBeVisible({ timeout: 10_000 });
    await addForm
      .locator('[data-agent-id="vault-add-key"]')
      .first()
      .fill(ROUTING_KEY);
    await addForm
      .locator('[data-agent-id="vault-add-value"]')
      .first()
      .fill(ROUTING_VALUE);
    await addForm
      .getByRole("button", { name: /Save secret/i })
      .first()
      .click();

    const row = page.getByTestId(`vault-entry-row-${ROUTING_KEY}`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Expand the row → enable profiles (migrate creates the `default` profile).
    await row.getByRole("button", { name: /^Expand$/ }).click();
    const profilesPanel = page.getByTestId(`profiles-panel-${ROUTING_KEY}`);
    await expect(profilesPanel).toBeVisible({ timeout: 10_000 });
    await profilesPanel
      .getByRole("button", { name: /Enable profiles/i })
      .click();

    // After migration the "Add profile" affordance appears; add `work`.
    await profilesPanel.getByRole("button", { name: /Add profile/i }).click();
    const addProfileForm = page.getByTestId(`add-profile-form-${ROUTING_KEY}`);
    await expect(addProfileForm).toBeVisible({ timeout: 10_000 });
    await addProfileForm
      .locator(`[data-agent-id="vault-profile-id-${ROUTING_KEY}"]`)
      .fill(PROFILE_ID);
    await addProfileForm
      .locator(`[data-agent-id="vault-profile-value-${ROUTING_KEY}"]`)
      .fill("e2e-routing-profile-value");
    await addProfileForm.getByRole("button", { name: /Save profile/i }).click();
    await expect(addProfileForm).toHaveCount(0, { timeout: 10_000 });

    // Routing tab → add a rule scoped to an agent, bound to the `work` profile.
    await gotoRoutingTab(page);
    await page.getByRole("button", { name: /Add rule/i }).click();
    const ruleForm = page.getByTestId("routing-add-rule-form");
    await expect(ruleForm).toBeVisible({ timeout: 10_000 });

    await ruleForm.getByPlaceholder(/OPENROUTER_/i).fill(ROUTING_KEY);

    // Scope defaults to "agent"; pick the first real agent option. The scope and
    // profile pickers are now Radix selects (themed, 44px touch, agent-addressable)
    // rather than native `<select>`, so they render a portal listbox of
    // role="option" items instead of `<option>` elements (#8793).
    const agentSelect = ruleForm.locator(
      '[data-agent-id="routing-scope-agent"]',
    );
    await agentSelect.click();
    const agentOptions = page.getByRole("option");
    await expect(
      agentOptions.first(),
      "live runtime must expose at least one agent for routing scope",
    ).toBeVisible({ timeout: 10_000 });
    await agentOptions.first().click();

    await ruleForm.locator('[data-agent-id="routing-rule-profile"]').click();
    // The profile was created with id `work`; its option label echoes the id when
    // no display name is set. Match by name, falling back to the last option (the
    // newly-created profile) if the runtime supplies a different display label.
    const profileByName = page.getByRole("option", {
      name: new RegExp(PROFILE_ID, "i"),
    });
    if (await profileByName.count()) {
      await profileByName.first().click();
    } else {
      await page.getByRole("option").last().click();
    }

    await ruleForm.getByRole("button", { name: /Save rule/i }).click();

    // Real PUT /api/secrets/routing → 200, and the saved config comes back so the
    // rules table renders the new row.
    await expect.poll(routingWrites).toBeGreaterThan(0);
    const rulesTable = page.getByTestId("routing-rules-table");
    await expect(rulesTable).toBeVisible({ timeout: 15_000 });
    await expect(rulesTable).toContainText(ROUTING_KEY);

    // Persistence: leave and re-open the Routing tab; the rule survives because
    // it round-tripped through the real backend.
    await gotoSecretsTab(page);
    await gotoRoutingTab(page);
    await expect(page.getByTestId("routing-rules-table")).toContainText(
      ROUTING_KEY,
      { timeout: 15_000 },
    );

    // Cleanup: delete the rule, then delete the seeded key.
    page.once("dialog", (dialog) => void dialog.accept());
    await page
      .getByRole("button", {
        name: new RegExp(`Delete rule for ${ROUTING_KEY}`),
      })
      .first()
      .click();
    await expect(routingWrites()).toBeGreaterThan(0);

    await deleteSeedKeyIfPresent(page);
    await closeVaultModal(page);
  });
});
