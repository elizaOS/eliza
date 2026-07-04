/**
 * Zoom Web Client PlatformStrategies — anonymous guest join via
 * https://app.zoom.us/wc/<id>/join?pwd=…, waiting-room handling, mixed-audio
 * capture with explicit capability detection (in-browser element capture
 * first, PulseAudio parecord fallback on Linux), DOM active-speaker
 * attribution, removal monitoring, and leave. Ported from Vexa
 * (services/vexa-bot/core/src/platforms/zoom/web/*, Apache-2.0). No native
 * Zoom SDK.
 *
 * error-policy:J4 — the many `.catch(() => {})` / `.catch(() => null)` guards on
 * `page.locator(...).click()`/`waitFor()`/`getAttribute()` are designed
 * best-effort UI automation against a page whose exact controls vary per Zoom
 * build/AB-test. A missing optional control is an expected degrade, not a
 * failure; the join outcome is decided by the presence checks and the
 * `MeetingEndReason` the strategy returns, not by any single click succeeding.
 */

import { logger } from "@elizaos/core";
import type { MeetingEndReason } from "@elizaos/shared";
import type { Page } from "playwright-core";
import type { MeetingBotSession } from "../../types.js";
import type {
  AdmissionOutcome,
  PlatformStrategies,
} from "../shared/strategy.js";
import {
  classifyZoomPage,
  isZoomAudioInitUrl,
  isZoomDomainUrl,
  type ZoomPageSnapshot,
} from "./page-state.js";
import { PulsePcmCapture } from "./pulse-capture.js";
import {
  zoomActiveSpeakerBarSelector,
  zoomActiveSpeakerSelector,
  zoomAudioButtonSelector,
  zoomJoinButtonSelector,
  zoomLeaveButtonSelector,
  zoomLeaveConfirmSelectors,
  zoomNameInputSelector,
  zoomParticipantNameSelector,
  zoomParticipantsButtonSelector,
  zoomPasscodeInputSelector,
  zoomPermissionDismissSelector,
  zoomPreviewMuteSelector,
  zoomPreviewVideoSelector,
  zoomVideoButtonSelector,
} from "./selectors.js";
import { ZoomSpeakerAttributor } from "./speaker-attribution.js";

const TAG = "[ZoomAdapter]";

const HOST_NOT_STARTED_RETRY_MS = 15_000;
const HOST_NOT_STARTED_MAX_WAIT_MS = 10 * 60 * 1000;
/** How long each capture path gets to produce its first audio. */
const CAPTURE_PROBE_TIMEOUT_MS = 20_000;
/** Post-join grace before removal heuristics act (Zoom audio-init redirects). */
const REMOVAL_GRACE_PERIOD_MS = 20_000;

export interface ZoomStrategyOptions {
  /**
   * Per-bot PulseAudio null sink the browser was launched into
   * (PULSE_SINK env). When set, parecord on `<sink>.monitor` is the capture
   * fallback if in-browser element capture yields no audio.
   */
  pulseSinkName?: string;
}

async function snapshotPage(page: Page): Promise<ZoomPageSnapshot> {
  const leaveButtonVisible = await page
    .locator(zoomLeaveButtonSelector)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  const domState = await page
    .evaluate(() => {
      const liveAudioCount = Array.from(
        document.querySelectorAll("audio"),
      ).filter((el) => {
        const media = el as HTMLAudioElement;
        return (
          !media.paused &&
          media.srcObject instanceof MediaStream &&
          media.srcObject.getAudioTracks().length > 0 &&
          media.srcObject.getAudioTracks()[0].readyState === "live"
        );
      }).length;
      const preJoinControlsPresent = !!(
        document.querySelector("#input-for-name") ||
        document.querySelector("button.preview-join-button") ||
        document.querySelector(
          'input[placeholder*="passcode" i], input[placeholder*="password" i]',
        )
      );
      return {
        title: document.title,
        bodyText: document.body?.innerText || "",
        meetingAppVisible: !!document.querySelector(".meeting-app"),
        liveAudioCount,
        preJoinControlsPresent,
      };
    })
    .catch(() => ({
      title: "",
      bodyText: "",
      meetingAppVisible: false,
      liveAudioCount: 0,
      preJoinControlsPresent: true,
    }));
  return { leaveButtonVisible, ...domState };
}

/**
 * Dismiss known Zoom Web popups/modals overlaying meeting content
 * (AI Companion, guest-chat tooltip, feature tips, mic-muted advisory).
 */
async function dismissZoomPopups(page: Page): Promise<void> {
  const dismissTargets = [
    '.zm-modal button:has-text("OK")',
    '.relative-tooltip button:has-text("Got it")',
    '.settings-feature-tips button:has-text("OK")',
    '.ReactModal__Content button:has-text("OK")',
    '.ReactModal__Content button:has-text("Got it")',
    '[role="presentation"] button:has-text("OK")',
  ];
  for (const selector of dismissTargets) {
    const btn = page.locator(selector).first();
    const visible = await btn.isVisible({ timeout: 0 }).catch(() => false);
    if (visible) {
      await btn.click().catch(() => {});
      logger.info({ selector }, `${TAG} dismissed popup`);
    }
  }
}

/** Participant count parsed from the participants-button aria-label. */
async function readParticipantCount(page: Page): Promise<number | null> {
  return page
    .evaluate((buttonSelector: string) => {
      const btn = document.querySelector(buttonSelector);
      const aria = btn?.getAttribute("aria-label") || "";
      const match = aria.match(/(\d+)/);
      return match ? Number.parseInt(match[1], 10) : null;
    }, zoomParticipantsButtonSelector)
    .catch(() => null);
}

export function createZoomStrategies(
  options: ZoomStrategyOptions = {},
): PlatformStrategies {
  return {
    async join(page: Page, session: MeetingBotSession): Promise<void> {
      const { meetingUrl, botName } = session.config;
      logger.info({ meetingUrl }, `${TAG} navigating to Zoom web client`);

      // Host-not-started retry loop: the /wc/ URL serves "Error - Zoom" /
      // "This meeting link is invalid (3,001)" until the host starts.
      const startTime = Date.now();
      for (;;) {
        if (session.signal.aborted)
          throw new Error(`${TAG} join aborted by stop request`);
        await page.goto(meetingUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(2000);

        const snapshot = await snapshotPage(page);
        const state = classifyZoomPage(snapshot);
        if (state === "auth_required") {
          throw new Error(
            `${TAG} meeting requires authenticated Zoom users — anonymous guest join is not possible`,
          );
        }
        if (state !== "host_not_started") break;

        if (Date.now() - startTime >= HOST_NOT_STARTED_MAX_WAIT_MS) {
          throw new Error(
            `${TAG} host did not start the meeting within the wait timeout`,
          );
        }
        logger.info(
          {
            retryInMs: HOST_NOT_STARTED_RETRY_MS,
          },
          `${TAG} host not started yet — retrying`,
        );
        await page.waitForTimeout(HOST_NOT_STARTED_RETRY_MS);
      }

      // Permission dialogs (shown up to twice: camera+mic, then mic-only).
      // Click "Allow" — without joining the audio channel Zoom never creates
      // <audio> elements and element capture gets nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        const allowBtn = page.locator('button:has-text("Allow")').first();
        if (await allowBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
          await allowBtn.click().catch(() => {});
          logger.info(
            `${TAG} granted media permission (attempt ${attempt + 1})`,
          );
          await page.waitForTimeout(600);
          continue;
        }
        const dismissBtn = page.locator(zoomPermissionDismissSelector).first();
        if (await dismissBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          logger.warn(
            `${TAG} no "Allow" button — dismissing permission dialog (element capture may be unavailable)`,
          );
          await dismissBtn.click().catch(() => {});
          await page.waitForTimeout(600);
        } else {
          break;
        }
      }

      logger.info(`${TAG} waiting for pre-join name input`);
      await page.waitForSelector(zoomNameInputSelector, { timeout: 30_000 });

      // Passcode-entry pre-join page: if a passcode field renders, the ?pwd=
      // in the URL was insufficient and the join button never enables.
      const passcodeVisible = await page
        .locator(zoomPasscodeInputSelector)
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (passcodeVisible) {
        const pwd = new URL(meetingUrl).searchParams.get("pwd");
        if (pwd) {
          await page.locator(zoomPasscodeInputSelector).first().fill(pwd);
          logger.info(`${TAG} filled passcode field from meeting URL`);
        } else {
          throw new Error(
            `${TAG} meeting requires a passcode but the meeting URL has no ?pwd= parameter`,
          );
        }
      }

      // Real keyboard events — synthetic input events don't satisfy Zoom's
      // React form validation and the Join button stays disabled.
      await page
        .locator(zoomNameInputSelector)
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
      await page.locator(zoomNameInputSelector).first().fill("");
      await page.keyboard.type(botName, { delay: 30 });
      logger.info({ botName }, `${TAG} typed bot name`);

      await page
        .waitForFunction(
          (sel: string) => {
            const btn = document.querySelector(sel) as HTMLButtonElement | null;
            return (
              !!btn && !btn.classList.contains("disabled") && !btn.disabled
            );
          },
          zoomJoinButtonSelector,
          { timeout: 8000 },
        )
        .catch(() =>
          logger.warn(
            `${TAG} join button still disabled after typing name — attempting click anyway`,
          ),
        );

      // Mute mic in preview (receive-only bot).
      const muteBtn = page.locator(zoomPreviewMuteSelector);
      const muteLabel = await muteBtn
        .getAttribute("aria-label")
        .catch(() => null);
      if (muteLabel === "Mute") {
        await muteBtn.click().catch(() => {});
        logger.info(`${TAG} muted microphone in preview`);
      }
      // Stop video in preview.
      const videoBtn = page.locator(zoomPreviewVideoSelector);
      const videoLabel = await videoBtn
        .getAttribute("aria-label")
        .catch(() => null);
      if (videoLabel === "Stop Video") {
        await videoBtn.click().catch(() => {});
        logger.info(`${TAG} stopped video in preview`);
      }

      // DOM-direct join click — Zoom's .preview-meeting-info overlay
      // intercepts Playwright's hit-tested click.
      const clicked = await page.evaluate((sel: string) => {
        const btn = document.querySelector(sel) as HTMLButtonElement | null;
        if (!btn || btn.classList.contains("disabled") || btn.disabled)
          return false;
        btn.click();
        return true;
      }, zoomJoinButtonSelector);
      if (!clicked) {
        logger.warn(
          `${TAG} DOM-direct join click failed — falling back to forced click`,
        );
        const joinBtn = page.locator(zoomJoinButtonSelector);
        await joinBtn.waitFor({ state: "visible", timeout: 10_000 });
        await joinBtn.click({ force: true, timeout: 10_000 });
      }
      logger.info(`${TAG} join clicked — waiting for meeting to load`);
      await page.waitForTimeout(3000);
    },

    async waitForAdmission(
      page: Page,
      session: MeetingBotSession,
      timeoutMs: number,
    ): Promise<AdmissionOutcome> {
      const first = classifyZoomPage(await snapshotPage(page));
      if (first === "in_meeting") {
        logger.info(`${TAG} admitted immediately (no waiting room)`);
        return "admitted";
      }
      if (first === "waiting_room") {
        logger.info(`${TAG} in waiting room — awaiting host admission`);
      }

      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (session.signal.aborted) return "timeout";
        await page.waitForTimeout(2000);
        const state = classifyZoomPage(await snapshotPage(page));
        if (state === "in_meeting") {
          logger.info(`${TAG} admitted — Leave button visible`);
          return "admitted";
        }
        if (state === "removed_or_ended") {
          logger.info(`${TAG} rejected from waiting room or meeting ended`);
          return "rejected";
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (elapsedSec % 20 === 0) {
          logger.info({ elapsedSec, state }, `${TAG} still awaiting admission`);
        }
      }
      logger.warn({ timeoutMs }, `${TAG} admission timed out`);
      return "timeout";
    },

    async checkAdmissionSilent(page: Page): Promise<boolean> {
      // Zoom UI transiently hides elements during popup dismissals — retry.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (classifyZoomPage(await snapshotPage(page)) === "in_meeting")
          return true;
        if (attempt < 2) await page.waitForTimeout(1000);
      }
      return false;
    },

    async prepare(page: Page, _session: MeetingBotSession): Promise<void> {
      await dismissZoomPopups(page);

      // Join computer audio — invariant: without it Zoom never creates
      // <audio> elements and element capture gets zero data.
      let audioJoined = false;
      for (let attempt = 0; attempt < 3 && !audioJoined; attempt++) {
        const liveAudioCount = await page
          .evaluate(
            () =>
              Array.from(document.querySelectorAll("audio")).filter((el) => {
                const media = el as HTMLAudioElement;
                return (
                  !media.paused &&
                  media.srcObject instanceof MediaStream &&
                  media.srcObject.getAudioTracks().length > 0 &&
                  media.srcObject.getAudioTracks()[0].readyState === "live"
                );
              }).length,
          )
          .catch(() => 0);
        if (liveAudioCount > 0) {
          logger.info({ liveAudioCount }, `${TAG} audio already flowing`);
          audioJoined = true;
          break;
        }

        const computerAudioBtn = page
          .locator(
            [
              'button:has-text("Join with Computer Audio")',
              'button:has-text("Join Audio by Computer")',
              'button:has-text("Computer Audio")',
            ].join(", "),
          )
          .first();
        if (
          await computerAudioBtn.isVisible({ timeout: 1500 }).catch(() => false)
        ) {
          await computerAudioBtn.click().catch(() => {});
          logger.info(`${TAG} clicked "Join with Computer Audio"`);
          audioJoined = true;
          break;
        }

        const audioBtn = page.locator(zoomAudioButtonSelector).first();
        if (await audioBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          const label =
            (await audioBtn.getAttribute("aria-label").catch(() => null)) || "";
          if (label === "Mute" || label === "Unmute") {
            logger.info(`${TAG} audio already joined (mic toggle visible)`);
            audioJoined = true;
            break;
          }
          if (
            label.toLowerCase().includes("join audio") ||
            label.toLowerCase() === "audio"
          ) {
            await audioBtn.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(1500);
            if (
              await computerAudioBtn
                .isVisible({ timeout: 3000 })
                .catch(() => false)
            ) {
              await computerAudioBtn.click().catch(() => {});
              logger.info(`${TAG} joined computer audio via footer dialog`);
              audioJoined = true;
              break;
            }
            continue;
          }
        }
        await page.waitForTimeout(2000);
      }
      if (!audioJoined) {
        logger.warn(
          `${TAG} could not confirm computer-audio join — capture probe will fail the session if no audio arrives`,
        );
      }

      // Video off in-meeting (preview toggle doesn't always carry over).
      const inMeetingVideoBtn = page.locator(zoomVideoButtonSelector).first();
      if (
        await inMeetingVideoBtn.isVisible({ timeout: 2000 }).catch(() => false)
      ) {
        const label = await inMeetingVideoBtn
          .getAttribute("aria-label")
          .catch(() => null);
        if (label === "Stop Video") {
          await inMeetingVideoBtn.click().catch(() => {});
          logger.info(`${TAG} video disabled post-admission`);
        }
      }
    },

    async startRecording(
      page: Page,
      session: MeetingBotSession,
    ): Promise<MeetingEndReason> {
      const attributor = new ZoomSpeakerAttributor({ sink: session.sink });
      let elementChunks = 0;
      let pulseCapture: PulsePcmCapture | null = null;

      await page.exposeFunction(
        "__elizaZoomAudioChunk",
        (samples: number[]) => {
          elementChunks += 1;
          attributor.onAudioChunk(Float32Array.from(samples));
        },
      );

      // ── Capture path 1: in-browser element capture ─────────────────────
      await page.evaluate(() => {
        const win = window as typeof window & {
          __elizaZoomAudioChunk?: (samples: number[]) => void;
          __elizaZoomCaptureStarted?: boolean;
        };
        if (win.__elizaZoomCaptureStarted) return;
        win.__elizaZoomCaptureStarted = true;
        const wired = new WeakSet<HTMLMediaElement>();
        const wire = () => {
          const elements = Array.from(
            document.querySelectorAll("audio"),
          ) as HTMLAudioElement[];
          for (const el of elements) {
            if (wired.has(el)) continue;
            if (!(el.srcObject instanceof MediaStream)) continue;
            if (el.srcObject.getAudioTracks().length === 0) continue;
            wired.add(el);
            const ctx = new AudioContext({ sampleRate: 16000 });
            const source = ctx.createMediaStreamSource(el.srcObject);
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e: AudioProcessingEvent) => {
              const data = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
              if (Math.sqrt(sum / data.length) < 0.005) return;
              win.__elizaZoomAudioChunk?.(Array.from(data));
            };
            source.connect(processor);
            processor.connect(ctx.destination);
          }
        };
        wire();
        setInterval(wire, 2000);
      });

      // ── Capability detection: probe element capture, fall back to Pulse ─
      const probeStart = Date.now();
      while (
        elementChunks === 0 &&
        Date.now() - probeStart < CAPTURE_PROBE_TIMEOUT_MS
      ) {
        if (session.signal.aborted) return "requested_stop";
        await page.waitForTimeout(1000);
      }

      if (elementChunks > 0) {
        logger.info(
          { elementChunks },
          `${TAG} in-browser element capture active`,
        );
      } else if (options.pulseSinkName) {
        logger.warn(
          { sink: options.pulseSinkName },
          `${TAG} element capture produced no audio in ${CAPTURE_PROBE_TIMEOUT_MS}ms — falling back to PulseAudio parecord`,
        );
        pulseCapture = new PulsePcmCapture({
          device: options.pulseSinkName,
          onChunk: (samples) => attributor.onAudioChunk(samples),
        });
        pulseCapture.start();
        const pulseProbeStart = Date.now();
        while (
          pulseCapture.receivedFirstAudioAt === null &&
          Date.now() - pulseProbeStart < CAPTURE_PROBE_TIMEOUT_MS
        ) {
          if (session.signal.aborted) {
            pulseCapture.stop();
            return "requested_stop";
          }
          await page.waitForTimeout(1000);
        }
        if (pulseCapture.receivedFirstAudioAt === null) {
          pulseCapture.stop();
          throw new Error(
            `${TAG} no meeting audio captured: in-browser element capture and PulseAudio ` +
              `(${options.pulseSinkName}.monitor) both produced zero audio within ${CAPTURE_PROBE_TIMEOUT_MS}ms`,
          );
        }
        logger.info(
          { sink: options.pulseSinkName },
          `${TAG} PulseAudio capture active`,
        );
      } else {
        throw new Error(
          `${TAG} no meeting audio captured: in-browser element capture produced zero audio within ` +
            `${CAPTURE_PROBE_TIMEOUT_MS}ms and no PulseAudio sink is available on this host ` +
            `(Linux with PulseAudio is required for the parecord fallback)`,
        );
      }

      // ── Active-speaker attribution + roster + alone monitoring ─────────
      const { autoLeave, botName } = session.config;
      const startedAt = Date.now();
      const knownParticipants = new Map<string, number>();
      let aloneMs = 0;
      let everHadOthers = false;
      let popupTick = 0;

      try {
        while (!session.signal.aborted) {
          await page.waitForTimeout(2000);
          if (session.signal.aborted) break;

          // Active speaker: main tile (normal layout) or --active bar tile
          // (screen-share layout).
          const speakerName = await page
            .evaluate(
              (sel: { active: string; bar: string; footer: string }) => {
                const nameFrom = (container: Element | null): string | null => {
                  if (!container) return null;
                  const footer = container.querySelector(sel.footer);
                  if (!footer) return null;
                  const span = footer.querySelector("span");
                  return (
                    span?.textContent?.trim() ||
                    (footer as HTMLElement).innerText?.trim() ||
                    null
                  );
                };
                return (
                  nameFrom(document.querySelector(sel.active)) ||
                  nameFrom(document.querySelector(sel.bar))
                );
              },
              {
                active: zoomActiveSpeakerSelector,
                bar: zoomActiveSpeakerBarSelector,
                footer: zoomParticipantNameSelector,
              },
            )
            .catch(() => null);
          const isBotTile =
            !!speakerName &&
            speakerName.toLowerCase().includes(botName.toLowerCase());
          attributor.onActiveSpeakerPoll(isBotTile ? null : speakerName);

          // Roster from visible tile names (excluding the bot).
          const tileNames = await page
            .evaluate((footerSelector: string) => {
              return Array.from(
                document.querySelectorAll(`${footerSelector} span`),
              )
                .map((s) => s.textContent?.trim())
                .filter((n): n is string => !!n);
            }, zoomParticipantNameSelector)
            .catch(() => [] as string[]);
          const nowMs = Date.now();
          const current = new Set(
            tileNames.filter(
              (n) => !n.toLowerCase().includes(botName.toLowerCase()),
            ),
          );
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

          // Alone detection: participants-button count when available
          // (includes the bot → alone means count <= 1), else tile roster.
          const count = await readParticipantCount(page);
          const alone = count !== null ? count <= 1 : current.size === 0;
          if (alone) {
            aloneMs += 2000;
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

          popupTick += 1;
          if (popupTick % 3 === 0) {
            await dismissZoomPopups(page).catch(() => {});
          }
        }
        return "requested_stop";
      } finally {
        pulseCapture?.stop();
        attributor.finalize();
      }
    },

    async startRemovalMonitor(
      page: Page,
      session: MeetingBotSession,
    ): Promise<MeetingEndReason> {
      const joinedAtMs = Date.now();
      let consecutiveLeaveButtonMisses = 0;

      while (!session.signal.aborted) {
        await page.waitForTimeout(3000).catch(() => {});
        if (page.isClosed()) {
          logger.warn(`${TAG} page closed under the removal monitor`);
          return "removed_by_admin";
        }
        const inGrace = Date.now() - joinedAtMs < REMOVAL_GRACE_PERIOD_MS;

        const snapshot = await snapshotPage(page);
        if (classifyZoomPage(snapshot) === "removed_or_ended") {
          logger.info(`${TAG} removal/end-of-meeting detected via page text`);
          return "removed_by_admin";
        }

        const url = page.url();
        if (!inGrace && !isZoomAudioInitUrl(url)) {
          if (url && !url.startsWith("about:") && !isZoomDomainUrl(url)) {
            logger.info(
              { url },
              `${TAG} navigated away from Zoom domain — meeting ended`,
            );
            return "removed_by_admin";
          }
          if (url.includes("/signin") || url.includes("/login")) {
            logger.info(
              { url },
              `${TAG} redirected to Zoom sign-in — meeting ended`,
            );
            return "removed_by_admin";
          }
        }

        // Leave button absence: require consecutive misses (~9 s) — Zoom UI
        // transitions (popups, tooltips) hide it briefly.
        if (!snapshot.leaveButtonVisible && !snapshot.meetingAppVisible) {
          consecutiveLeaveButtonMisses += 1;
          if (
            !inGrace &&
            !isZoomAudioInitUrl(url) &&
            consecutiveLeaveButtonMisses >= 3 &&
            (snapshot.title === "Error - Zoom" ||
              snapshot.title === "" ||
              snapshot.title === "Zoom" ||
              snapshot.title.startsWith("Join"))
          ) {
            logger.info(
              {
                url,
                title: snapshot.title,
              },
              `${TAG} meeting UI gone (${consecutiveLeaveButtonMisses} misses)`,
            );
            return "removed_by_admin";
          }
        } else {
          consecutiveLeaveButtonMisses = 0;
        }
      }
      // Aborted: never resolve for the normal path — park until flow settles.
      return new Promise<MeetingEndReason>(() => {});
    },

    async leave(page: Page): Promise<void> {
      if (page.isClosed()) return;
      try {
        await dismissZoomPopups(page).catch(() => {});
        // Native DOM click — Playwright's synthetic events don't reliably
        // trigger Zoom's React handlers.
        const clicked = await page.evaluate(() => {
          const selectors = [
            '[footer-section="right"] button[aria-label="Leave"]',
            'button[aria-label="Leave"]',
            'button[aria-label*="Leave"]',
          ];
          for (const sel of selectors) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn) {
              btn.click();
              return sel;
            }
          }
          return null;
        });
        if (!clicked) {
          logger.warn(
            `${TAG} leave button not found — navigating away to drop WebRTC`,
          );
          await page.goto("about:blank").catch(() => {});
          return;
        }
        logger.info({ selector: clicked }, `${TAG} clicked Leave`);
        await page.waitForTimeout(500);

        const confirmClicked = await page.evaluate((selectors: string[]) => {
          for (const sel of selectors) {
            const btn = document.querySelector(sel) as HTMLElement | null;
            if (btn) {
              btn.click();
              return sel;
            }
          }
          return null;
        }, zoomLeaveConfirmSelectors);
        if (confirmClicked) {
          logger.info({ selector: confirmClicked }, `${TAG} confirmed leave`);
          // Hold the page open long enough for the WebRTC peer to disconnect.
          await page.waitForTimeout(2500);
        } else {
          logger.warn(
            `${TAG} leave confirm dialog not found — navigating away`,
          );
          await page.goto("about:blank").catch(() => {});
          await page.waitForTimeout(1000);
        }
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
