/**
 * Shared interaction helpers for E2E tests.
 */

import type { Locator, Page } from '@playwright/test';
import { TIMEOUTS } from './test-data';

export async function clickTab(page: Page, tabName: string): Promise<boolean> {
  const tab = page
    .locator(
      `[role="tab"]:has-text("${tabName}"), button:has-text("${tabName}"), a:has-text("${tabName}")`
    )
    .first();
  if (!(await tab.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)))
    return false;
  const _before = await page.locator('body').textContent();
  await tab.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  return true;
}

export async function fillAndVerify(
  page: Page,
  selector: string,
  value: string
): Promise<string | null> {
  const input = page.locator(selector).first();
  if (!(await input.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false)))
    return null;
  await input.clear().catch(() => {});
  await input.fill(value);
  await page.waitForTimeout(300);
  return input.inputValue();
}

export async function openModal(
  page: Page,
  triggerSelector: string,
  modalSelector = '[role="dialog"]'
): Promise<Locator | null> {
  const trigger = page.locator(triggerSelector).first();
  if (
    !(await trigger.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false))
  )
    return null;
  await trigger.click({ force: true });
  await page.waitForTimeout(500);
  const modal = page.locator(modalSelector).first();
  return (await modal.isVisible({ timeout: TIMEOUTS.SHORT }).catch(() => false))
    ? modal
    : null;
}

export async function closeModal(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  const closeButton = page
    .locator('button[aria-label*="close" i], button:has(svg.lucide-x)')
    .first();
  if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await closeButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

export async function scrollToLoadMore(
  page: Page,
  itemSelector: string
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

export async function pageContainsText(
  page: Page,
  ...texts: string[]
): Promise<boolean> {
  const content = await page.locator('body').textContent();
  if (!content) return false;
  const lower = content.toLowerCase();
  return texts.some((t) => lower.includes(t.toLowerCase()));
}

export async function clickFirstVisible(
  page: Page,
  selectors: string[]
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

export function getBaseUrl(): string {
  return process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';
}

export async function navigateToTab(
  page: Page,
  basePath: string,
  tabName: string
): Promise<void> {
  await page.goto(`${getBaseUrl()}${basePath}?tab=${tabName}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(1500);
}
