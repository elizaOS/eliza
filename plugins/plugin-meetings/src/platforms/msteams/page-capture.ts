/**
 * In-page capture wiring for Microsoft Teams.
 *
 * Installs three page → Node bindings and one injected observer script:
 *  - __elizaTeamsAudioChunk(samples)      RMS-gated 16 kHz PCM from the ONE
 *                                         mixed remote audio element
 *  - __elizaTeamsCaption(speaker, text)   latest caption (author, text) pair
 *  - __elizaTeamsVoiceLevel(name, speaking) voice-level-indicator fallback
 *
 * The routing state machine lives Node-side in TeamsCaptionRouter; the page
 * only observes and ships events. Ported from Vexa msteams/recording.ts
 * (caption-driven speaker routing + voice-level detection, Apache-2.0).
 */

import { logger } from "@elizaos/core";
import type { Page } from "playwright-core";
import { teamsCaptionSelectors, teamsVoiceLevelSelector } from "./selectors.js";
import type { TeamsCaptionRouter } from "./caption-router.js";

const TAG = "[MsTeamsAdapter]";

/**
 * Init script: patch RTCPeerConnection so every remote audio track is
 * mirrored into a hidden autoplay <audio> element the capture script can
 * find. Must be added BEFORE navigation (page.addInitScript).
 */
export async function installTeamsRemoteAudioHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      __elizaRemoteAudioHookInstalled?: boolean;
    };
    if (win.__elizaRemoteAudioHookInstalled || typeof RTCPeerConnection !== "function") {
      return;
    }
    win.__elizaRemoteAudioHookInstalled = true;
    const OriginalPC = RTCPeerConnection;

    function wrapPeerConnection(this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
      const pc = new OriginalPC(...args);
      const handleTrack = (event: RTCTrackEvent) => {
        if (!event.track || event.track.kind !== "audio") return;
        const stream = (event.streams && event.streams[0]) || new MediaStream([event.track]);
        const audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1.0;
        audioEl.dataset.elizaInjected = "true";
        audioEl.style.position = "absolute";
        audioEl.style.left = "-9999px";
        audioEl.style.width = "1px";
        audioEl.style.height = "1px";
        audioEl.srcObject = stream;
        audioEl.play?.().catch(() => {});
        if (document.body) {
          document.body.appendChild(audioEl);
        } else {
          document.addEventListener(
            "DOMContentLoaded",
            () => document.body?.appendChild(audioEl),
            { once: true },
          );
        }
      };
      pc.addEventListener("track", handleTrack);
      return pc;
    }
    wrapPeerConnection.prototype = OriginalPC.prototype;
    Object.setPrototypeOf(wrapPeerConnection, OriginalPC);
    (window as { RTCPeerConnection: unknown }).RTCPeerConnection = wrapPeerConnection;
  });
}

/**
 * Expose the router bindings and start the in-page observers:
 * mixed-audio ScriptProcessor capture (RMS-gated), caption MutationObserver
 * + 200 ms backup poll, and voice-level-indicator polling.
 */
export async function startTeamsPageCapture(
  page: Page,
  router: TeamsCaptionRouter,
): Promise<void> {
  await page.exposeFunction("__elizaTeamsAudioChunk", (samples: number[]) => {
    router.onAudioChunk(Float32Array.from(samples));
  });
  await page.exposeFunction("__elizaTeamsCaption", (speaker: string, text: string) => {
    router.onCaption(speaker, text);
  });
  await page.exposeFunction(
    "__elizaTeamsVoiceLevel",
    (name: string, speaking: boolean) => {
      router.onVoiceActivity(name, speaking);
    },
  );

  await page.evaluate(
    ({ captionSelectors, voiceLevelSelector }) => {
      const win = window as typeof window & {
        __elizaTeamsAudioChunk?: (samples: number[]) => void;
        __elizaTeamsCaption?: (speaker: string, text: string) => void;
        __elizaTeamsVoiceLevel?: (name: string, speaking: boolean) => void;
        __elizaTeamsCaptureStarted?: boolean;
      };
      if (win.__elizaTeamsCaptureStarted) return;
      win.__elizaTeamsCaptureStarted = true;

      // ── Mixed-audio capture: ONE audio element, 16 kHz, RMS-gated ──────
      const RMS_GATE = 0.01;
      let audioWired = false;
      const wireAudio = () => {
        if (audioWired) return;
        const candidates = Array.from(document.querySelectorAll("audio"));
        const el = candidates.find(
          (a) =>
            a.srcObject instanceof MediaStream &&
            a.srcObject.getAudioTracks().length > 0,
        );
        if (!el || !(el.srcObject instanceof MediaStream)) return;
        audioWired = true;
        const ctx = new AudioContext({ sampleRate: 16000 });
        const source = ctx.createMediaStreamSource(el.srcObject);
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          const data = e.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          if (Math.sqrt(sum / data.length) < RMS_GATE) return;
          win.__elizaTeamsAudioChunk?.(Array.from(data));
        };
        source.connect(processor);
        processor.connect(ctx.destination);
      };
      wireAudio();
      const audioRetry = setInterval(() => {
        wireAudio();
        if (audioWired) clearInterval(audioRetry);
      }, 2000);

      // ── Caption observation: author/text atom pairs, latest pair wins ──
      const processCaptions = () => {
        const wrapper = document.querySelector(captionSelectors.rendererWrapper);
        if (!wrapper) return;
        const authors = wrapper.querySelectorAll(captionSelectors.authorName);
        const texts = wrapper.querySelectorAll(captionSelectors.captionText);
        if (authors.length === 0 || texts.length === 0) return;
        const speaker = (authors[authors.length - 1].textContent || "").trim();
        const text = (texts[texts.length - 1].textContent || "").trim();
        if (!speaker || !text) return;
        win.__elizaTeamsCaption?.(speaker, text);
      };

      let captionObserverActive = false;
      const startCaptionObserver = () => {
        const wrapper = document.querySelector(captionSelectors.rendererWrapper);
        if (!wrapper) return false;
        captionObserverActive = true;
        const observer = new MutationObserver(processCaptions);
        observer.observe(wrapper, { childList: true, subtree: true, characterData: true });
        processCaptions();
        // Backup poll — MutationObserver can miss virtual-DOM updates.
        setInterval(processCaptions, 200);
        return true;
      };
      const captionDetect = setInterval(() => {
        if (!captionObserverActive && startCaptionObserver()) clearInterval(captionDetect);
      }, 2000);
      startCaptionObserver();

      // ── Voice-level fallback: poll speaking outlines, map to tile names ─
      const speakingNow = new Set<string>();
      const nameForOutline = (outline: Element): string | null => {
        let node: Element | null = outline;
        for (let depth = 0; depth < 8 && node; depth++) {
          const label = node.getAttribute("aria-label");
          if (label && label.trim().length > 1 && label.trim().length < 60) {
            return label.trim();
          }
          node = node.parentElement;
        }
        return null;
      };
      setInterval(() => {
        const outlines = Array.from(document.querySelectorAll(voiceLevelSelector));
        const active = new Set<string>();
        for (const outline of outlines) {
          // vdi-frame-occlusion on the outline or an ancestor = speaking.
          let cur: Element | null = outline;
          let speaking = false;
          while (cur) {
            if (cur.classList.contains("vdi-frame-occlusion")) {
              speaking = true;
              break;
            }
            cur = cur.parentElement;
          }
          if (!speaking) continue;
          const name = nameForOutline(outline);
          if (name) active.add(name);
        }
        for (const name of active) {
          if (!speakingNow.has(name)) {
            speakingNow.add(name);
            win.__elizaTeamsVoiceLevel?.(name, true);
          }
        }
        for (const name of Array.from(speakingNow)) {
          if (!active.has(name)) {
            speakingNow.delete(name);
            win.__elizaTeamsVoiceLevel?.(name, false);
          }
        }
      }, 500);
    },
    {
      captionSelectors: {
        rendererWrapper: teamsCaptionSelectors.rendererWrapper,
        authorName: teamsCaptionSelectors.authorName,
        captionText: teamsCaptionSelectors.captionText,
      },
      voiceLevelSelector: teamsVoiceLevelSelector,
    },
  );
  logger.info(`${TAG} page capture installed (mixed audio + captions + voice-level fallback)`);
}

/**
 * Enable Teams live captions for the bot's own session:
 * More → Language and speech → Show live captions (host menu) or the direct
 * "Captions" item (guest menu). Captions are per-user, so this always works
 * regardless of meeting settings. Ported from Vexa msteams/captions.ts.
 */
export async function enableTeamsLiveCaptions(page: Page): Promise<void> {
  logger.info(`${TAG} enabling Teams live captions`);
  await page.waitForTimeout(3000);

  const alreadyEnabled = await page.evaluate(
    (wrapperSelector) => !!document.querySelector(wrapperSelector),
    teamsCaptionSelectors.rendererWrapper,
  );
  if (alreadyEnabled) {
    logger.info(`${TAG} live captions already enabled`);
    return;
  }

  try {
    const moreButton = page
      .locator(
        `${teamsCaptionSelectors.moreButton}, button[aria-label="More"], button[aria-label="More options"]`,
      )
      .first();
    await moreButton.click({ timeout: 8000 });
    await page.waitForTimeout(1000);

    // Guest menu: direct "Captions" item. Host menu: "Language and speech"
    // submenu → "…live captions".
    const enableResult = await page.evaluate(() => {
      const visibleItems = () =>
        Array.from(
          document.querySelectorAll(
            '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
          ),
        ).filter((el) => (el as HTMLElement).offsetParent !== null);

      for (const el of visibleItems()) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (
          text === "captions" ||
          text === "show live captions" ||
          text === "turn on live captions"
        ) {
          (el as HTMLElement).click();
          return { clicked: (el.textContent || "").trim(), path: "direct" as const };
        }
      }
      for (const el of visibleItems()) {
        const text = (el.textContent || "").toLowerCase();
        if (text.includes("language") && text.includes("speech")) {
          (el as HTMLElement).click();
          return { clicked: (el.textContent || "").trim(), path: "submenu" as const };
        }
      }
      return { clicked: null, path: "none" as const };
    });

    if (!enableResult.clicked) {
      throw new Error("captions menu item not found in More menu");
    }
    logger.info(`${TAG} clicked captions menu item "${enableResult.clicked}" (${enableResult.path})`);
    await page.waitForTimeout(1000);

    if (enableResult.path === "submenu") {
      const clickedSub = await page.evaluate(() => {
        const items = document.querySelectorAll(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
        );
        for (const el of items) {
          const text = (el.textContent || "").toLowerCase();
          if (text.includes("live captions") && (el as HTMLElement).offsetParent) {
            (el as HTMLElement).click();
            return (el.textContent || "").trim();
          }
        }
        return null;
      });
      if (clickedSub) {
        logger.info(`${TAG} clicked live-captions submenu item "${clickedSub}"`);
      } else {
        logger.warn(`${TAG} live captions submenu item not found`);
      }
      await page.waitForTimeout(1500);
    }

    const enabled = await page.evaluate(
      (wrapperSelector) => !!document.querySelector(wrapperSelector),
      teamsCaptionSelectors.rendererWrapper,
    );
    if (enabled) {
      logger.info(`${TAG} live captions enabled`);
    } else {
      logger.warn(
        `${TAG} captions menu clicked but wrapper not visible yet — page observer will pick it up when it appears`,
      );
    }
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {});
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      `${TAG} could not enable live captions — falling back to voice-level attribution`,
    );
  }
}
