/**
 * Microsoft Teams PlatformStrategies — guest prejoin, lobby admission,
 * caption-driven per-speaker capture, removal monitoring, and leave.
 * Ported from Vexa (services/vexa-bot/core/src/platforms/msteams/*,
 * Apache-2.0) onto the shared meeting-flow strategy contract.
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { Page } from "playwright-core";
import type { MeetingBotSession } from "../../types.js";
import { anySelectorVisible } from "../shared/selectors.js";
import type {
  AdmissionOutcome,
  PlatformStrategies,
} from "../shared/strategy.js";
import { TeamsCaptionRouter } from "./caption-router.js";
import {
  enableTeamsLiveCaptions,
  installTeamsRemoteAudioHook,
  startTeamsPageCapture,
} from "./page-capture.js";
import {
  teamsCameraButtonSelectors,
  teamsComputerAudioRadioSelectors,
  teamsContinueButtonSelectors,
  teamsContinueWithoutMediaSelectors,
  teamsDontUseAudioRadioSelectors,
  teamsInitialAdmissionIndicators,
  teamsJoinButtonSelectors,
  teamsLeaveSelectors,
  teamsNameInputSelectors,
  teamsRejectionIndicators,
  teamsRemovalPhrases,
  teamsSpeakerEnableSelectors,
  teamsWaitingRoomIndicators,
} from "./selectors.js";

const TAG = "[MsTeamsAdapter]";

async function isAdmitted(page: Page): Promise<boolean> {
  for (const selector of teamsInitialAdmissionIndicators) {
    const element = page.locator(selector).first();
    const visible = await element.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await element
      .getAttribute("aria-disabled")
      .catch(() => null);
    if (disabled !== "true") return true;
  }
  return false;
}

async function isInWaitingRoom(page: Page): Promise<boolean> {
  if (await anySelectorVisible(page, teamsWaitingRoomIndicators)) return true;
  // "Join now" still visible means the prejoin never completed — treat as
  // pre-admission, not failure.
  return anySelectorVisible(page, ['button:has-text("Join now")']);
}

async function isRejected(page: Page): Promise<boolean> {
  return anySelectorVisible(page, teamsRejectionIndicators);
}

/**
 * Wait for the Teams prejoin controls, clicking through the intermittent
 * "Continue without audio or video" modal (it blocks the prejoin: "Join now"
 * never enables until dismissed) and any lingering "Continue" button.
 */
async function waitForPreJoinReadiness(
  page: Page,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let continueClicks = 0;
  let continueWithoutMediaClicks = 0;

  while (Date.now() - start < timeoutMs) {
    const withoutMedia = page
      .locator(teamsContinueWithoutMediaSelectors.join(", "))
      .first();
    if (
      (await withoutMedia.isVisible().catch(() => false)) &&
      continueWithoutMediaClicks < 3
    ) {
      continueWithoutMediaClicks += 1;
      logger.info(
        `${TAG} dismissing "Continue without audio or video" modal (attempt ${continueWithoutMediaClicks})`,
      );
      await withoutMedia.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    const joinNowVisible = await page
      .locator('button:has-text("Join now"), [aria-label*="Join now"]')
      .first()
      .isVisible()
      .catch(() => false);
    const nameInputVisible = await page
      .locator(teamsNameInputSelectors.join(", "))
      .first()
      .isVisible()
      .catch(() => false);
    if (joinNowVisible || nameInputVisible) return true;

    const continueButton = page
      .locator(teamsContinueButtonSelectors[0])
      .first();
    if (
      (await continueButton.isVisible().catch(() => false)) &&
      continueClicks < 2
    ) {
      continueClicks += 1;
      await continueButton.click().catch(() => {});
      await page.waitForTimeout(500);
      continue;
    }

    await page.waitForTimeout(300);
  }
  logger.warn(
    { url: page.url() },
    `${TAG} timed out waiting for prejoin readiness`,
  );
  return false;
}

interface TeamsRuntimeState {
  router: TeamsCaptionRouter | null;
}

export function createMsTeamsStrategies(): PlatformStrategies {
  const state: TeamsRuntimeState = { router: null };

  return {
    async join(page: Page, session: MeetingBotSession): Promise<void> {
      const { meetingUrl, botName } = session.config;
      await installTeamsRemoteAudioHook(page);

      logger.info({ meetingUrl }, `${TAG} navigating to Teams meeting`);
      await page.goto(meetingUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(500);

      // "Continue on this browser" interstitial.
      const continueButton = page
        .locator(teamsContinueButtonSelectors[0])
        .first();
      const continueClicked = await continueButton
        .waitFor({ timeout: 10_000 })
        .then(async () => {
          await continueButton.click();
          return true;
        })
        .catch(() => false);
      if (continueClicked) {
        logger.info(`${TAG} clicked "Continue on this browser"`);
        await page.waitForTimeout(500);
      }

      await waitForPreJoinReadiness(page, 45_000);

      // Camera off — unobtrusive guest bot.
      const cameraButton = page.locator(teamsCameraButtonSelectors[0]).first();
      const cameraClicked = await cameraButton
        .waitFor({ timeout: 5000 })
        .then(async () => {
          await cameraButton.click();
          return true;
        })
        .catch(() => false);
      logger.info(
        `${TAG} camera ${cameraClicked ? "turned off" : "button not found (already off)"}`,
      );

      // Display name.
      const nameInput = page
        .locator(teamsNameInputSelectors.join(", "))
        .first();
      const nameSet = await nameInput
        .waitFor({ timeout: 5000 })
        .then(async () => {
          await nameInput.fill(botName);
          return true;
        })
        .catch(() => false);
      if (nameSet) {
        logger.info({ botName }, `${TAG} display name set`);
      } else {
        logger.warn(`${TAG} display name input not found — continuing`);
      }

      // Computer audio: required to RECEIVE the meeting's mixed audio stream.
      const computerAudioRadio = page
        .locator(teamsComputerAudioRadioSelectors.join(", "))
        .first();
      const dontUseAudioRadio = page
        .locator(teamsDontUseAudioRadioSelectors.join(", "))
        .first();
      if (await computerAudioRadio.isVisible().catch(() => false)) {
        const dontUseChecked =
          (await dontUseAudioRadio.isVisible().catch(() => false)) &&
          (await dontUseAudioRadio
            .getAttribute("aria-checked")
            .catch(() => null)) === "true";
        if (dontUseChecked) {
          logger.info(
            `${TAG} "Don't use audio" was selected — switching to Computer audio`,
          );
        }
        await computerAudioRadio.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(200);
        logger.info(`${TAG} Computer audio selected`);
      }
      const speakerOn = page
        .locator(teamsSpeakerEnableSelectors.join(", "))
        .first();
      if (await speakerOn.isVisible().catch(() => false)) {
        await speakerOn.click({ timeout: 5000 }).catch(() => {});
        logger.info(`${TAG} speaker enabled via toggle`);
      }

      // Join now.
      const joinNow = page.locator('button:has-text("Join now")').first();
      if (await joinNow.isVisible().catch(() => false)) {
        await joinNow.click();
        logger.info(`${TAG} clicked "Join now"`);
      } else {
        const fallbackJoin = page
          .locator(teamsJoinButtonSelectors.join(", "))
          .first();
        await fallbackJoin.waitFor({ timeout: 10_000 });
        await fallbackJoin.click();
        logger.info(`${TAG} clicked join button (fallback selector)`);
      }
      await page.waitForTimeout(1000);

      // Mute mic — the bot never transmits.
      await page.keyboard.press("Control+Shift+M").catch(() => {});
      await page.waitForTimeout(200);
    },

    async waitForAdmission(
      page: Page,
      session: MeetingBotSession,
      timeoutMs: number,
    ): Promise<AdmissionOutcome> {
      // Immediate admission (no lobby)?
      if ((await isAdmitted(page)) && !(await isInWaitingRoom(page))) {
        logger.info(`${TAG} admitted immediately — no lobby`);
        return "admitted";
      }

      const start = Date.now();
      const pollMs = 2000;
      while (Date.now() - start < timeoutMs) {
        if (session.signal.aborted) return "timeout";
        await page.waitForTimeout(pollMs);

        if (await isRejected(page)) {
          logger.info(`${TAG} admission rejected by meeting admin`);
          return "rejected";
        }
        if (await isAdmitted(page)) {
          logger.info(`${TAG} admitted to the meeting (Leave button visible)`);
          return "admitted";
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (elapsedSec % 20 === 0) {
          logger.info({ elapsedSec }, `${TAG} still awaiting admission`);
        }
      }
      logger.warn({ timeoutMs }, `${TAG} admission timed out`);
      return "timeout";
    },

    async checkAdmissionSilent(page: Page): Promise<boolean> {
      return (await isAdmitted(page)) && !(await isInWaitingRoom(page));
    },

    async prepare(page: Page, session: MeetingBotSession): Promise<void> {
      // Live captions drive per-speaker routing — enable them first so the
      // caption DOM exists before the observer script installs.
      await enableTeamsLiveCaptions(page);
      state.router = new TeamsCaptionRouter({
        sink: session.sink,
        botName: session.config.botName,
      });
      await startTeamsPageCapture(page, state.router);
    },

    async startRecording(
      page: Page,
      session: MeetingBotSession,
    ): Promise<MeetingEndReason> {
      const router = state.router;
      if (!router) {
        throw new Error(
          `${TAG} startRecording called before prepare — no caption router`,
        );
      }
      const { autoLeave } = session.config;
      const startedAt = Date.now();
      const knownParticipants = new Map<string, number>(); // name → joinedAtMs
      let aloneMs = 0;
      let everHadOthers = false;

      logger.info(
        `${TAG} recording started (caption-driven per-speaker routing)`,
      );

      try {
        while (!session.signal.aborted) {
          await page.waitForTimeout(5000);
          if (session.signal.aborted) break;

          // ARIA roster: menuitems in the participant surface that contain an
          // avatar image; the bot itself is excluded by name.
          const names = await page
            .evaluate((botName: string) => {
              const items = Array.from(
                document.querySelectorAll('[role="menuitem"]'),
              ) as HTMLElement[];
              const found = new Set<string>();
              for (const item of items) {
                const hasImg = !!(
                  item.querySelector("img") ||
                  item.querySelector('[role="img"]')
                );
                if (!hasImg) continue;
                const aria = item.getAttribute("aria-label");
                const name = aria?.trim() || (item.textContent || "").trim();
                if (
                  name &&
                  !name.toLowerCase().includes(botName.toLowerCase())
                ) {
                  found.add(name);
                }
              }
              return Array.from(found);
            }, session.config.botName)
            .catch(() => null);
          if (names === null) continue; // page transitioning — removal monitor owns that

          const nowMs = Date.now();
          const current = new Set(names);
          for (const name of current) {
            if (!knownParticipants.has(name)) {
              knownParticipants.set(name, nowMs);
              session.sink.participantJoined({
                id: name,
                displayName: name,
                joinedAtMs: nowMs - startedAt,
              });
            }
          }
          for (const [name] of knownParticipants) {
            if (!current.has(name)) {
              knownParticipants.delete(name);
              session.sink.participantLeft(name, nowMs - startedAt);
            }
          }

          if (current.size === 0) {
            aloneMs += 5000;
            const limit = everHadOthers
              ? autoLeave.everyoneLeftTimeoutMs
              : autoLeave.noOneJoinedTimeoutMs;
            if (aloneMs >= limit) {
              logger.info(
                { aloneMs, everHadOthers },
                `${TAG} alone timeout reached`,
              );
              return everHadOthers
                ? "left_alone_timeout"
                : "startup_alone_timeout";
            }
          } else {
            aloneMs = 0;
            everHadOthers = true;
          }
        }
        return "requested_stop";
      } finally {
        router.finalize();
      }
    },

    async startRemovalMonitor(
      page: Page,
      session: MeetingBotSession,
    ): Promise<MeetingEndReason> {
      while (!session.signal.aborted) {
        await page.waitForTimeout(1500).catch(() => {});
        if (page.isClosed()) {
          logger.warn(`${TAG} page closed under the removal monitor`);
          return "removed_by_admin";
        }
        const removed = await page
          .evaluate((phrases: string[]) => {
            const bodyText = (document.body?.innerText || "").toLowerCase();
            if (phrases.some((p) => bodyText.includes(p))) return true;
            // Rejoin / Dismiss buttons render on the post-removal screen.
            const buttons = Array.from(
              document.querySelectorAll("button"),
            ) as HTMLElement[];
            for (const btn of buttons) {
              const text = (btn.textContent || "").trim().toLowerCase();
              const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
              if (
                text !== "rejoin" &&
                text !== "dismiss" &&
                !aria.includes("rejoin")
              )
                continue;
              if (btn.offsetWidth <= 0 || btn.offsetHeight <= 0) continue;
              const cs = getComputedStyle(btn);
              if (cs.display === "none" || cs.visibility === "hidden") continue;
              return true;
            }
            return false;
          }, teamsRemovalPhrases)
          .catch(() => false);
        if (removed) {
          logger.info(`${TAG} removal by admin detected`);
          return "removed_by_admin";
        }
      }
      // Aborted: never resolve for the normal path — park until flow settles.
      return new Promise<MeetingEndReason>(() => {});
    },

    async leave(page: Page): Promise<void> {
      if (page.isClosed()) return;
      try {
        for (const selector of teamsLeaveSelectors) {
          const button = page.locator(selector).first();
          if (await button.isVisible().catch(() => false)) {
            await button.click({ timeout: 3000 }).catch(() => {});
            logger.info({ selector }, `${TAG} clicked leave control`);
            await page.waitForTimeout(1000);
            return;
          }
        }
        logger.warn(
          `${TAG} no leave control found — closing page will drop the call`,
        );
      } catch (err) {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          `${TAG} leave attempt failed`,
        );
      }
    },
  };
}
