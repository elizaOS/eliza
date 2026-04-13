import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
  type MockApiServer,
  startMockApiServer,
} from "../electrobun-packaged/mock-api";

const DIST_INDEX = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "dist",
  "index.html",
);
const DIST_INDEX_URL = pathToFileURL(DIST_INDEX).href;

const STORAGE = {
  "eliza:onboarding-complete": "1",
  "eliza:onboarding:step": "activate",
  "eliza:ui-shell-mode": "native",
  "eliza:active-server": JSON.stringify({
    id: "local:embedded",
    kind: "local",
    label: "This device",
  }),
};

let apiServer: MockApiServer | null = null;

test.describe("packaged file:// hash routing", () => {
  test.skip(!fs.existsSync(DIST_INDEX), "apps/app/dist/index.html is required");

  test.beforeAll(async () => {
    apiServer = await startMockApiServer({ onboardingComplete: true });
  });

  test.afterAll(async () => {
    await apiServer?.close();
  });

  test.beforeEach(async ({ page }) => {
    const apiBase = apiServer?.baseUrl ?? "http://127.0.0.1:31337";
    await page.addInitScript(
      ({ apiBaseUrl, storage }) => {
        window.__ELIZA_API_BASE__ = apiBaseUrl;
        for (const [key, value] of Object.entries(storage)) {
          localStorage.setItem(key, value);
        }
      },
      { apiBaseUrl: apiBase, storage: STORAGE },
    );
  });

  test("loads chat and settings routes under file:// with hash parity", async ({
    page,
  }) => {
    test.fixme(); // file:// protocol loading fails — React root never mounts
    await page.goto(`${DIST_INDEX_URL}#/chat`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/#\/chat$/);
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();

    await page.goto(`${DIST_INDEX_URL}#/settings`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId("settings-shell")).toBeVisible();
  });
});
