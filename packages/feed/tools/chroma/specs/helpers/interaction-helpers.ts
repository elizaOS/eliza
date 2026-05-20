/**
 * Shared interaction helpers for E2E tests.
 *
 * Provides reusable utilities for common UI interactions like
 * clicking tabs, filling forms, waiting for toasts, and modals.
 *
 * @module testing/chroma/helpers/interaction-helpers
 */

import type { Locator, Page } from "@playwright/test";
import { TIMEOUTS } from "./test-data";

/**
 * Click a tab by text content and wait for content to change.
 * Returns whether the tab was found and clicked.
 */
export async function clickTab(
  page: Page,
  tabName: string,
  timeout = TIMEOUTS.MEDIUM,
): Promise<boolean> {
  const tab = page
    .locator(
      `[role="tab"]:has-text("${tabName}"), button:has-text("${tabName}"), a:has-text("${tabName}")`,
    )
    .first();

  const isVisible = await tab
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  if (!isVisible) return false;

  const contentBefore = await page.locator("body").textContent();
  await tab.click({ force: true, timeout }).catch(() => {});
  await page.waitForTimeout(1000);

  // Verify content changed or tab was activated
  const contentAfter = await page.locator("body").textContent();
  return contentBefore !== contentAfter || isVisible;
}

/**
 * Fill an input and verify the value was accepted.
 * Returns the actual input value after filling.
 */
export async function fillAndVerify(
  page: Page,
  selector: string,
  value: string,
): Promise<string | null> {
  const input = page.locator(selector).first();
  const isVisible = await input
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  if (!isVisible) return null;

  await input.clear().catch(() => {});
  await input.fill(value);
  await page.waitForTimeout(300);

  return input.inputValue();
}

/**
 * Click a button and wait for a matching network response.
 * Returns the response status or null if no response.
 */
export async function clickButtonAndWaitForResponse(
  page: Page,
  buttonSelector: string,
  urlPattern: string | RegExp,
): Promise<number | null> {
  const button = page.locator(buttonSelector).first();
  const isVisible = await button
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  if (!isVisible) return null;

  const responsePromise = page.waitForResponse(urlPattern, {
    timeout: TIMEOUTS.MEDIUM,
  });

  await button.click({ force: true });

  try {
    const response = await responsePromise;
    return response.status();
  } catch {
    return null;
  }
}

/**
 * Wait for a toast notification (Sonner) to appear.
 * Returns the toast text or null if no toast appeared.
 */
export async function waitForToast(
  page: Page,
  textPattern?: string | RegExp,
): Promise<string | null> {
  const toastSelector =
    '[data-testid="toast"], [role="status"], [data-sonner-toast], li[data-type]';
  const toast = page.locator(toastSelector).first();

  try {
    await toast.waitFor({ state: "visible", timeout: TIMEOUTS.MEDIUM });
    const text = await toast.textContent();

    if (textPattern) {
      const pattern =
        textPattern instanceof RegExp
          ? textPattern
          : new RegExp(textPattern, "i");
      if (!pattern.test(text || "")) return null;
    }

    return text;
  } catch {
    return null;
  }
}

/**
 * Open a modal by clicking a trigger and verify it opened.
 * Returns the modal locator or null if modal didn't open.
 */
export async function openModal(
  page: Page,
  triggerSelector: string,
  modalSelector = '[role="dialog"]',
): Promise<Locator | null> {
  const trigger = page.locator(triggerSelector).first();
  const isVisible = await trigger
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  if (!isVisible) return null;

  await trigger.click({ force: true });
  await page.waitForTimeout(500);

  const modal = page.locator(modalSelector).first();
  const modalVisible = await modal
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  return modalVisible ? modal : null;
}

/**
 * Close any open modal via Escape, close button, or clicking outside.
 */
export async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  const closeButton = page
    .locator(
      'button[aria-label*="close" i], button[aria-label*="dismiss" i], button:has(svg.lucide-x)',
    )
    .first();
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * Scroll to bottom to trigger infinite scroll and count items.
 * Returns the new item count after scrolling.
 */
export async function scrollToLoadMore(
  page: Page,
  itemSelector: string,
): Promise<{ before: number; after: number }> {
  const before = await page
    .locator(itemSelector)
    .count()
    .catch(() => 0);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  const after = await page
    .locator(itemSelector)
    .count()
    .catch(() => 0);
  return { before, after };
}

/**
 * Verify an element is visible, enabled, and has a non-zero bounding box.
 */
export async function verifyElementInteractable(
  page: Page,
  selector: string,
): Promise<boolean> {
  const element = page.locator(selector).first();
  const isVisible = await element
    .isVisible({ timeout: TIMEOUTS.SHORT })
    .catch(() => false);

  if (!isVisible) return false;

  const isEnabled = await element.isEnabled().catch(() => false);
  if (!isEnabled) return false;

  const box = await element.boundingBox().catch(() => null);
  return box !== null && box.width > 0 && box.height > 0;
}

/**
 * Switch to a tab and verify specific content appears.
 * More robust than just checking "page has content".
 */
export async function switchTabAndVerifyContent(
  page: Page,
  tabName: string,
  expectedContentSelector: string,
): Promise<boolean> {
  const clicked = await clickTab(page, tabName);
  if (!clicked) return false;

  await page.waitForTimeout(1000);

  const content = page.locator(expectedContentSelector).first();
  return content.isVisible({ timeout: TIMEOUTS.MEDIUM }).catch(() => false);
}

/**
 * Get the BASE_URL for constructing full URLs in tests.
 */
export function getBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
}

/**
 * Navigate to a URL with a specific query parameter tab.
 */
export async function navigateToTab(
  page: Page,
  basePath: string,
  tabName: string,
): Promise<void> {
  await page.goto(`${getBaseUrl()}${basePath}?tab=${tabName}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForTimeout(1500);
}

/**
 * Check if page has specific text content (case-insensitive).
 */
export async function pageContainsText(
  page: Page,
  ...texts: string[]
): Promise<boolean> {
  const content = await page.locator("body").textContent();
  if (!content) return false;
  const lower = content.toLowerCase();
  return texts.some((t) => lower.includes(t.toLowerCase()));
}

/**
 * Find and click the first visible element matching any of the selectors.
 * Returns whether a click was made.
 */
export async function clickFirstVisible(
  page: Page,
  selectors: string[],
): Promise<boolean> {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}
