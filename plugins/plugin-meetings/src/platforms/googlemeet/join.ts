/**
 * Google Meet guest join. Anonymous only (bot name, no OAuth): navigate → fill
 * name → mute mic + camera → "Ask to join". Clicks/fills route through the
 * pluggable InputDriver so Meet's synthetic-input detection is defeated
 * (XTEST on Linux, humanized Playwright motion elsewhere). Faithful port of
 * Vexa's joinGoogleMeeting (Apache-2.0) minus the authenticated branch.
 */

import type { Page } from "playwright-core";
import { logger } from "@elizaos/core";
import type { InputDriver } from "../humanized/index.js";
import type { MeetingBotSession } from "../../types.js";
import { waitForAnySelector } from "../shared/selectors.js";
import {
  googleCameraButtonSelectors,
  googleJoinButtonSelectors,
  googleMicrophoneButtonSelectors,
  googleNameInputSelectors,
} from "./selectors.js";

const NAME_INPUT_TIMEOUT_MS = 120_000;
const JOIN_BUTTON_TIMEOUT_MS = 60_000;
const MUTE_PROBE_TIMEOUT_MS = 2_000;

export async function joinGoogleMeeting(
  page: Page,
  session: MeetingBotSession,
  input: InputDriver,
): Promise<void> {
  const { meetingUrl, botName } = session.config;
  await page.goto(meetingUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  await page.waitForTimeout(1000);

  logger.info("[GoogleMeetJoin] locating name input");
  const { handle: nameHandle } = await waitForAnySelector(
    page,
    googleNameInputSelectors,
    NAME_INPUT_TIMEOUT_MS,
    "name input",
  );
  await input.fill(page, nameHandle, botName);
  logger.info(`[GoogleMeetJoin] filled bot name: ${botName}`);

  // Mute mic + camera if the toggles are present (best-effort — the lobby may
  // already have them off, in which case the selectors won't match).
  await muteControl(page, input, googleMicrophoneButtonSelectors, "microphone");
  await muteControl(page, input, googleCameraButtonSelectors, "camera");

  const { handle: joinHandle } = await waitForAnySelector(
    page,
    googleJoinButtonSelectors,
    JOIN_BUTTON_TIMEOUT_MS,
    "join button",
  );
  await input.click(page, joinHandle);
  logger.info(`[GoogleMeetJoin] ${botName} requested to join`);
}

async function muteControl(
  page: Page,
  input: InputDriver,
  selectors: readonly string[],
  label: string,
): Promise<void> {
  try {
    const handle = await page.waitForSelector(selectors[0], { timeout: MUTE_PROBE_TIMEOUT_MS });
    if (handle) {
      await input.click(page, handle);
      logger.info(`[GoogleMeetJoin] ${label} toggled off`);
    }
  } catch {
    logger.info(`[GoogleMeetJoin] ${label} already off or not present`);
  }
}
