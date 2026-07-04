/**
 * Selector-racing helpers shared by browser platform adapters.
 *
 * Meeting UIs are localized and their obfuscated class names rotate between
 * releases. Every control is located by an ORDERED list: locale-agnostic
 * structural selectors first, English-text fallbacks last. `waitForAnySelector`
 * races the whole list and resolves on the FIRST match — a per-selector timeout
 * never aborts the others, so the fallbacks all get a fair chance. On total
 * failure it throws LOUD with the full list tried (no silent skips).
 */

import type { ElementHandle, Page } from "playwright-core";
import { logger } from "@elizaos/core";

export interface SelectorMatch {
  handle: ElementHandle<Element>;
  selector: string;
}

/**
 * Wait for the first of an ordered selector list to become visible. Resolves
 * with the matched handle + winning selector; throws if none match in time.
 */
export async function waitForAnySelector(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
  label: string,
): Promise<SelectorMatch> {
  const winner = await new Promise<SelectorMatch | null>((resolve) => {
    let pending = selectors.length;
    let settled = false;
    if (pending === 0) {
      resolve(null);
      return;
    }
    for (const selector of selectors) {
      page
        .waitForSelector(selector, { timeout: timeoutMs, state: "visible" })
        .then((el) => {
          if (!settled && el) {
            settled = true;
            resolve({ handle: el as ElementHandle<Element>, selector });
          } else if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        })
        .catch(() => {
          if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        });
    }
  });

  if (winner) {
    logger.info(`[MeetingSelectors] located ${label} via: ${winner.selector}`);
    return winner;
  }

  throw new Error(
    `[MeetingSelectors] could not locate ${label} by any of ${selectors.length} selectors after ${timeoutMs}ms (tried: ${selectors.join(" | ")})`,
  );
}

/**
 * True if any selector in the list is currently visible. Non-throwing; used for
 * cheap presence probes (waiting-room / rejection / removal detection).
 */
export async function anySelectorVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      if (await page.locator(selector).first().isVisible()) return true;
    } catch {
      // Malformed/absent selector — try the next one.
    }
  }
  return false;
}

/**
 * Count DOM occurrences of any selector in the list (presence, not visibility).
 * Some admission signals (participant tiles) exist but auto-hide, so presence is
 * the reliable check.
 */
export async function anySelectorPresent(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch {
      // Ignore and continue.
    }
  }
  return false;
}
