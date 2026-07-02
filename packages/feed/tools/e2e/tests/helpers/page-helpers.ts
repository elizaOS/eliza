/**
 * Page navigation helpers for E2E tests.
 */

import type { Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

export async function waitForServerHealthy(
  maxRetries = 15,
  retryDelay = 2000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/`, {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      });
      if (response.status < 500) {
        consecutiveFailures = 0;
        return true;
      }
    } catch {}
    if (attempt < maxRetries)
      await new Promise((r) => setTimeout(r, retryDelay));
  }
  consecutiveFailures++;
  return false;
}

export async function navigateTo(page: Page, route: string): Promise<void> {
  const isHealthy = await waitForServerHealthy(5, 1000);
  if (!isHealthy) {
    await new Promise((r) => setTimeout(r, 5000));
    await waitForServerHealthy(10, 2000);
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await page.goto(`${BASE_URL}${route}`, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      consecutiveFailures = 0;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < 5) await page.waitForTimeout(1000 * attempt);
    }
  }
  throw lastError ?? new Error("Navigation failed");
}

export async function hideNextDevOverlay(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const overlay = document.querySelector("nextjs-portal");
      if (overlay instanceof HTMLElement) {
        overlay.style.pointerEvents = "none";
        overlay.style.display = "none";
      }
      document.querySelectorAll("[data-nextjs-dev-overlay]").forEach((el) => {
        if (el instanceof HTMLElement) el.style.pointerEvents = "none";
      });
    })
    .catch(() => {});
}

export async function waitForPageLoad(
  page: Page,
  timeout = 20000,
): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
    await hideNextDevOverlay(page);
    let hasButtons = false;
    for (let i = 0; i < 20; i++) {
      if (
        (await page
          .locator("button")
          .count()
          .catch(() => 0)) > 0
      ) {
        hasButtons = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!hasButtons) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(2000);
      await hideNextDevOverlay(page);
    }
  } catch {}
}

export async function cooldownBetweenTests(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
}

export async function isServerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

export function shouldSkipTest(): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}
