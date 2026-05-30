import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const LABEL = process.env.HOME_SHOT_LABEL ?? "before";
const OUT = path.join(process.cwd(), "test-results", "home-shots");

test("capture home view desktop + mobile", async ({ page }) => {
  await mkdir(OUT, { recursive: true });
  await installDefaultAppRoutes(page);
  await seedAppStorage(page);

  // Desktop
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAppPath(page, "/");
  await expect(page.getByTestId("home-view")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("home-chat-input")).toBeVisible();
  await expect(page.getByTestId("home-default-apps")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-desktop.png`) });

  // Focused composer (recent chats / draft) to check reflow
  await page.getByTestId("home-chat-input").fill("hello eliza");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-desktop-focus.png`) });
  await page.getByTestId("home-chat-input").fill("");

  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${LABEL}-mobile.png`) });
});
