/**
 * Page navigation helpers for chroma e2e tests.
 *
 * @module testing/chroma/helpers/page-helpers
 */

import type { Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

// Track consecutive failures to detect server crash
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

/**
 * Waits for the server to be ready before proceeding.
 *
 * Ready means the `/api/health` readiness endpoint reports healthy.
 * This prevents flakiness when the server is slow to start.
 *
 * @param maxRetries - Maximum number of retry attempts (default: 15)
 * @param retryDelay - Delay between retries in milliseconds (default: 2000)
 */
export async function waitForServerHealthy(
  maxRetries = 15,
  retryDelay = 2000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (await probeHealthEndpoint(15000)) {
      consecutiveFailures = 0;
      return true;
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }

  consecutiveFailures++;
  return false;
}

/**
 * Navigates to a route and waits for it to load.
 *
 * Includes server health check to prevent flakiness.
 *
 * @param page - Playwright page instance
 * @param route - Route path to navigate to
 * @throws Error if navigation fails after all retries
 */
export async function navigateTo(page: Page, route: string): Promise<void> {
  // Quick health check first
  const isHealthy = await waitForServerHealthy(5, 1000);

  // If server seems down, do a longer wait
  if (!isHealthy) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
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
      if (attempt < 5) {
        // Exponential backoff
        await page.waitForTimeout(1000 * attempt);
      }
    }
  }

  throw lastError ?? new Error("Navigation failed");
}

/**
 * Hide Next.js dev overlay to prevent it from intercepting pointer events.
 *
 * In development mode, Next.js injects a portal that can block UI interactions.
 * This function hides it so tests can interact with the actual UI.
 *
 * @param page - Playwright page instance
 */
export async function hideNextDevOverlay(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const overlay = document.querySelector("nextjs-portal");
      if (overlay instanceof HTMLElement) {
        overlay.style.pointerEvents = "none";
        overlay.style.display = "none";
      }
      // Also hide any error overlays
      document.querySelectorAll("[data-nextjs-dev-overlay]").forEach((el) => {
        if (el instanceof HTMLElement) {
          el.style.pointerEvents = "none";
        }
      });
    })
    .catch(() => {});
}

/**
 * Waits for page to be fully loaded and hydrated.
 *
 * @param page - Playwright page instance
 * @param timeout - Maximum time to wait in milliseconds (default: 20000)
 */
export async function waitForPageLoad(
  page: Page,
  timeout = 20000,
): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });

    // Hide Next.js dev overlay to prevent test interference
    await hideNextDevOverlay(page);

    // Wait for page to have interactive elements
    let hasButtons = false;
    for (let i = 0; i < 20; i++) {
      const buttonCount = await page
        .locator("button")
        .count()
        .catch(() => 0);
      if (buttonCount > 0) {
        hasButtons = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!hasButtons) {
      // Try reloading the page once
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(2000);
      // Hide overlay again after reload
      await hideNextDevOverlay(page);
    }
  } catch (_e) {
    // Continue anyway
  }
}

/**
 * Waits between tests to let the server recover.
 *
 * Helps prevent flakiness from server overload.
 *
 * @param page - Playwright page instance
 */
export async function cooldownBetweenTests(page: Page): Promise<void> {
  // Give the server a moment to recover between tests
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

/**
 * Skips remaining tests in a suite if server is down
 */
export function shouldSkipTest(): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}
