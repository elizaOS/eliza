/**
 * Google Meet admission detection. Ported from Vexa (Apache-2.0), returning the
 * shared `AdmissionOutcome` ("admitted" | "rejected" | "timeout").
 *
 * Correctness rules preserved verbatim in spirit:
 *  - Waiting-room indicators are a NEGATIVE guard: while any is visible, toolbar
 *    buttons are false positives → not admitted.
 *  - Structural selectors ([data-participant-id], [data-self-name]) do NOT exist
 *    in the lobby and do NOT auto-hide, so DOM PRESENCE (count>0) is the reliable
 *    admitted signal; toolbar buttons remain visibility-gated.
 *  - A reCAPTCHA challenge renders the SAME "Return to home screen" affordance as
 *    an admin rejection. If a captcha is present we must NOT classify it as a
 *    rejection — keep waiting so a human/agent can solve it.
 */

import type { Page } from "playwright-core";
import { logger } from "@elizaos/core";
import type { AdmissionOutcome } from "../shared/strategy.js";
import { anySelectorPresent, anySelectorVisible } from "../shared/selectors.js";
import {
  googleInitialAdmissionIndicators,
  googleRejectionIndicators,
  googleWaitingRoomIndicators,
} from "./selectors.js";

const POLL_INTERVAL_MS = 2_000;
/** Structural selectors detected by DOM presence, not visibility (auto-hide-proof). */
const PRESENCE_SELECTORS = new Set(["[data-participant-id]", "[data-self-name]"]);

/** Detect an active reCAPTCHA (enterprise) challenge in any frame. */
export async function hasRecaptchaChallenge(page: Page): Promise<boolean> {
  try {
    for (const frame of page.frames()) {
      if ((frame.url() || "").includes("/recaptcha/")) return true;
    }
    return await page
      .locator('iframe[src*="recaptcha"]')
      .first()
      .isVisible()
      .catch(() => false);
  } catch {
    return false;
  }
}

/** True when the host has explicitly rejected the bot (captcha excluded). */
export async function checkForRejection(page: Page): Promise<boolean> {
  for (const selector of googleRejectionIndicators) {
    try {
      if (await page.locator(selector).first().isVisible()) {
        if (await hasRecaptchaChallenge(page)) {
          logger.info(
            `[GoogleMeetAdmission] reCAPTCHA present alongside "${selector}" — bot-detection, NOT host rejection; staying`,
          );
          return false;
        }
        logger.info(`[GoogleMeetAdmission] rejection detected: ${selector}`);
        return true;
      }
    } catch {
      // Continue to next selector.
    }
  }
  return false;
}

async function checkForWaitingRoom(page: Page): Promise<boolean> {
  return anySelectorVisible(page, googleWaitingRoomIndicators);
}

/**
 * Admitted iff no waiting-room indicator is visible AND a real in-call signal is
 * present. Wakes the auto-hiding toolbar with a pointer move before probing.
 */
export async function checkForAdmission(page: Page): Promise<boolean> {
  if (await checkForWaitingRoom(page)) return false;

  // Wake the auto-hiding in-call toolbar so visibility checks are meaningful.
  try {
    await page.mouse.move(640, 360);
    await page.mouse.move(960, 540);
  } catch {
    // Headless/no-input edge — fall through to presence checks.
  }

  for (const selector of googleInitialAdmissionIndicators) {
    try {
      if (PRESENCE_SELECTORS.has(selector)) {
        if ((await page.locator(selector).count()) > 0) return true;
        continue;
      }
      const el = page.locator(selector).first();
      if (await el.isVisible()) {
        if ((await el.getAttribute("aria-disabled")) !== "true") return true;
      }
    } catch {
      // Continue to next selector.
    }
  }
  return anySelectorPresent(page, [...PRESENCE_SELECTORS]);
}

/** Silent admission check (no side effects) — used for post-active re-verification. */
export async function checkAdmissionSilent(page: Page): Promise<boolean> {
  return checkForAdmission(page);
}

/**
 * Wait until admitted, rejected, or timed out. Polls at POLL_INTERVAL_MS,
 * bailing early on the terminal states. Aborting the session signal ends the
 * wait as a timeout (the flow handles the graceful stop).
 */
export async function waitForAdmission(
  page: Page,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<AdmissionOutcome> {
  if (await checkForAdmission(page)) return "admitted";
  if (await checkForRejection(page)) return "rejected";

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal.aborted) return "timeout";
    if (await checkForRejection(page)) return "rejected";
    if (await checkForAdmission(page)) return "admitted";
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  // Final terminal-state check before declaring timeout.
  if (await checkForRejection(page)) return "rejected";
  if (await checkForAdmission(page)) return "admitted";
  logger.info("[GoogleMeetAdmission] admission window elapsed without admittance");
  return "timeout";
}
