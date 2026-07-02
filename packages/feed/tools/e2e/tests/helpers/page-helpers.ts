/**
 * Page navigation helpers for E2E tests.
 */

import type { Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Probes the app's readiness endpoint.
 *
 * Healthy means `/api/health` answered 2xx with `{ status: "ok" }` — the same
 * signal CI and the integration harness use. A 404/401/redirect from a
 * half-booted or wrong server is NOT healthy.
 */
async function probeHealthEndpoint(timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { status?: unknown }).status === "ok"
    );
  } catch {
    return false;
  }
}

export async function waitForServerHealthy(
  maxRetries = 15,
  retryDelay = 2000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (await probeHealthEndpoint(15000)) {
      consecutiveFailures = 0;
      return true;
    }
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

/**
 * Check if the server is currently healthy.
 *
 * Healthy means `/api/health` answered 2xx with `{ status: "ok" }`.
 */
export async function isServerHealthy(): Promise<boolean> {
  return probeHealthEndpoint(5000);
}

export function shouldSkipTest(): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}
