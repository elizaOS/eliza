/**
 * Google Meet leave. Stateless: try each leave selector in the browser context
 * until one visible, clickable button works. Best-effort — never throws (the
 * flow calls this on every terminal path). Ported from Vexa's performLeaveAction
 * (Apache-2.0).
 */

import type { Page } from "playwright-core";
import { logger } from "@elizaos/core";
import { googleLeaveSelectors } from "./selectors.js";

export async function leaveGoogleMeet(page: Page): Promise<void> {
  if (page.isClosed()) return;
  try {
    const clicked = await page.evaluate((selectors: string[]) => {
      for (const selector of selectors) {
        const button = document.querySelector(selector) as HTMLElement | null;
        if (!button) continue;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
        if (!visible) continue;
        button.scrollIntoView({ block: "center" });
        button.click();
        return selector;
      }
      return null;
    }, [...googleLeaveSelectors]);

    if (clicked) {
      logger.info(`[GoogleMeetLeave] clicked leave control: ${clicked}`);
      // A confirmation dialog may appear — try once more for its "Leave" button.
      await page.waitForTimeout(500);
      await page.evaluate((selectors: string[]) => {
        for (const selector of selectors) {
          const button = document.querySelector(selector) as HTMLElement | null;
          if (button && button.getBoundingClientRect().width > 0) {
            button.click();
            return;
          }
        }
      }, [...googleLeaveSelectors]);
    } else {
      logger.warn("[GoogleMeetLeave] no visible leave control found");
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "[GoogleMeetLeave] leave attempt failed",
    );
  }
}
