/**
 * Browser acceptance for metadata, reveal auto-hide, cancel, and reload without
 * mutating a real Vault. The fixture exists only in the page's route layer; the
 * test never sends DELETE and never records or prints the revealed value.
 */

import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const FIXTURE_KEY = "E2E_NONDESTRUCTIVE_METADATA";

test("keeps a disposable fixture redacted across reveal, cancel, and reload", async ({
  page,
}) => {
  let deleteRequests = 0;

  await page.route("**/api/secrets/inventory", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        entries: [
          {
            key: FIXTURE_KEY,
            category: "provider",
            label: "Disposable browser QA",
            backend: "in-house",
            hasProfiles: false,
            kind: "secret",
          },
        ],
        securityFindings: [],
      }),
    });
  });

  await page.route(`**/api/secrets/inventory/${FIXTURE_KEY}`, async (route) => {
    if (route.request().method() === "DELETE") {
      deleteRequests += 1;
      await route.fulfill({ status: 500 });
      return;
    }
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        value: "disposable-browser-qa-value",
        source: "vault",
      }),
    });
  });

  await seedAppStorage(page, {
    "app-workspace-chrome:chat-collapsed": "true",
  });
  await openAppPath(page, "/vault");
  await expect(page.getByTestId("vault-tab-overview")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("vault-tab-secrets").click();

  const row = page.getByTestId(`vault-entry-row-${FIXTURE_KEY}`);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toContainText("Disposable browser QA");
  await expect(
    row.getByRole("button", { name: "Reveal Disposable browser QA" }),
  ).toBeVisible();

  await row
    .getByRole("button", { name: "Reveal Disposable browser QA" })
    .click();
  await expect(
    row.getByRole("button", { name: "Hide Disposable browser QA" }),
  ).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Reveal Disposable browser QA" }),
  ).toBeVisible({ timeout: 12_000 });

  await row
    .getByRole("button", { name: "Delete Disposable browser QA" })
    .click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel deleting Disposable browser QA" })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(deleteRequests).toBe(0);

  await page.reload();
  await expect(page.getByTestId("vault-tab-overview")).toBeVisible({
    timeout: 20_000,
  });
  await page.getByTestId("vault-tab-secrets").click();
  await expect(page.getByTestId(`vault-entry-row-${FIXTURE_KEY}`)).toBeVisible({
    timeout: 10_000,
  });
  expect(deleteRequests).toBe(0);
});
