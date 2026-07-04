/**
 * Google Meet removal monitor. Resolves ONLY when the bot is removed by an
 * admin or the page/tab dies under it — never on the normal path. Polls the
 * removal indicators at a fixed cadence; stops when the session signal aborts
 * (the flow aborts it once another racer wins). Ported from Vexa
 * startGoogleRemovalMonitor (Apache-2.0), adapted to a promise-returning shape.
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { Page } from "playwright-core";
import { anySelectorVisible } from "../shared/selectors.js";
import { googleRemovalIndicators } from "./selectors.js";

const CHECK_INTERVAL_MS = 1_500;

export function startRemovalMonitor(
  page: Page,
  signal: AbortSignal,
): Promise<MeetingEndReason> {
  return new Promise((resolve) => {
    if (signal.aborted) return; // Never resolves — the race is already decided.

    const timer = setInterval(async () => {
      if (signal.aborted || page.isClosed()) {
        clearInterval(timer);
        return;
      }
      try {
        if (await anySelectorVisible(page, googleRemovalIndicators)) {
          clearInterval(timer);
          logger.info("[GoogleMeetRemoval] removal detected");
          resolve("removed_by_admin");
        }
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "[GoogleMeetRemoval] removal check failed",
        );
      }
    }, CHECK_INTERVAL_MS);

    const onClose = () => {
      clearInterval(timer);
      logger.info("[GoogleMeetRemoval] page closed under bot");
      resolve("removed_by_admin");
    };
    page.once("close", onClose);

    signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
        page.off("close", onClose);
      },
      { once: true },
    );
  });
}
