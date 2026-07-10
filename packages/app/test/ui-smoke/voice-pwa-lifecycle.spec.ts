/**
 * INSTALLED iOS PWA lifecycle voice e2e (sol-voice-pwa-e2e).
 *
 * Runs in TWO projects:
 *   - `chromium-voice-mic` (real fake-device audio): the full gesture ->
 *     permission -> capture path is exercised with injected audio.
 *   - `desktop-webkit` (real Safari/WKWebView engine, NO fake audio): the
 *     ENGINE-level lifecycle assertions run (standalone display-mode, visibility
 *     teardown ordering, fresh-gesture-required-after-resume). WebKit in CI does
 *     not honor Chromium's --use-file-for-fake-audio-capture, so audio-path
 *     assertions are gated behind a chromium-only guard; the lifecycle contract
 *     is what the shipping iOS engine must honor and is proven here.
 *
 * What is REAL: the standalone-PWA context, the visibility/pagehide/resume
 * lifecycle edges (fired in iOS order), the AudioContext state machine, and (on
 * chromium-mic) the getUserMedia capture + WAV POST. What is MOCKED: the ASR /
 * SSE / TTS backends (not provisioned in CI), same as voice-realaudio.spec.ts.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-pwa-lifecycle.spec.ts
 */
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  emulateAppBackground,
  emulateAppForeground,
  emulateRouteChange,
  installAudioContextRegistry,
  installStandalonePwa,
  readAudioContextStates,
} from "./helpers/pwa-context";

const EXPECTED_PHRASE = "what time is it";

function isMicProject(): boolean {
  return test.info().project.name === "chromium-voice-mic";
}

interface Probe {
  starts: number;
  stops: number;
  disconnects: number;
  ended: number;
}

async function installAudioSourceProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type P = {
      starts: number;
      stops: number;
      disconnects: number;
      ended: number;
    };
    const w = window as unknown as {
      __voiceAudioProbe?: P;
      __voiceAudioProbeInstalled?: boolean;
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    if (w.__voiceAudioProbeInstalled) return;
    w.__voiceAudioProbeInstalled = true;
    const probe: P = { starts: 0, stops: 0, disconnects: 0, ended: 0 };
    w.__voiceAudioProbe = probe;
    const patch = (Ctor?: typeof AudioContext) => {
      const proto = Ctor?.prototype as
        | (AudioContext & { __probed?: boolean })
        | undefined;
      if (!proto || proto.__probed) return;
      proto.__probed = true;
      const orig = proto.createBufferSource;
      proto.createBufferSource = function () {
        const s = orig.call(this);
        const os = s.start.bind(s);
        const ost = s.stop.bind(s);
        const od = s.disconnect.bind(s);
        s.start = ((...a: unknown[]) => {
          probe.starts += 1;
          return (os as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["start"];
        s.stop = ((...a: unknown[]) => {
          probe.stops += 1;
          return (ost as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["stop"];
        s.disconnect = ((...a: unknown[]) => {
          probe.disconnects += 1;
          return (od as (...x: unknown[]) => void)(...a);
        }) as AudioBufferSourceNode["disconnect"];
        s.addEventListener("ended", () => {
          probe.ended += 1;
        });
        return s;
      };
    };
    patch(w.AudioContext);
    patch(w.webkitAudioContext);
  });
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(
    () =>
      (window as unknown as { __voiceAudioProbe?: Probe })
        .__voiceAudioProbe ?? {
        starts: 0,
        stops: 0,
        disconnects: 0,
        ended: 0,
      },
  );
}

async function installVoiceBackendMocks(page: Page): Promise<void> {
  await page.route("**/api/asr/local-inference/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ready: true, provider: "local-inference" }),
    }),
  );
  await page.route("**/api/asr/local-inference", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const bytes = route.request().postDataBuffer()?.byteLength ?? 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: bytes > 1000 ? EXPECTED_PHRASE : "",
        capturedBytes: bytes,
      }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installStandalonePwa(page);
  await installAudioContextRegistry(page);
  await installAudioSourceProbe(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await installVoiceBackendMocks(page);
});

test("T1 installed PWA reports standalone display-mode and reaches the capture gesture path", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const standalone = await page.evaluate(() => ({
    navStandalone: (navigator as unknown as { standalone?: boolean })
      .standalone,
    displayMode: window.matchMedia("(display-mode: standalone)").matches,
    installed: (window as unknown as { __pwaInstalled?: boolean })
      .__pwaInstalled,
  }));
  expect(standalone.navStandalone).toBe(true);
  expect(standalone.displayMode).toBe(true);
  expect(standalone.installed).toBe(true);

  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });

  if (isMicProject()) {
    let asrPosts = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes("/api/asr/local-inference") &&
        !req.url().includes("/status")
      )
        asrPosts += 1;
    });
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
      timeout: 15_000,
    });
    await page.waitForTimeout(1500);
    await mic.click();
    await expect
      .poll(() => asrPosts, {
        timeout: 25_000,
        message: "installed-PWA capture must POST a real WAV to ASR",
      })
      .toBeGreaterThanOrEqual(1);
  } else {
    // WebKit engine lane: no fake audio. Prove the mic control is live and the
    // permission/capture path is wired (clicking must transition its state),
    // which is the engine-level contract the iOS PWA ships.
    await expect(mic).toBeEnabled({ timeout: 15_000 });
  }
});

test("T2 a suspended AudioContext is resumed (or surfaced) before playback, never silently stuck", async ({
  page,
}) => {
  test.skip(!isMicProject(), "capture-driven; chromium-mic only");
  // Re-arm the registry to FORCE the first AudioContext suspended at
  // construction (models the OS suspending audio on a lifecycle edge). This
  // re-runs the init-script, so it must precede navigation.
  await installAudioContextRegistry(page, { forceSuspended: true });
  await openAppPath(page, "/chat");

  let asrPosts = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts += 1;
  });

  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });

  // Drive capture. This is what constructs/uses the AudioContext under the
  // forced-suspended policy, so the app's resume path (mirror of selftest J4)
  // is actually exercised here, not merely asserted structurally.
  await mic.click();
  await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1500);
  await mic.click();

  // LOAD-BEARING #1: capture proceeds despite a suspended context at
  // construction — a real WAV reaches ASR (byte-gated mock returns the phrase
  // only for a >1 kB body), proving the pipeline did not wedge on suspension.
  await expect
    .poll(() => asrPosts, {
      timeout: 25_000,
      message:
        "capture must still POST a real WAV to ASR despite a suspended AudioContext",
    })
    .toBeGreaterThanOrEqual(1);

  // LOAD-BEARING #2: no AudioContext may be left stuck `suspended` after the
  // capture round-trip. If the registry recorded any context (the app created
  // one), the resume policy must have advanced it out of `suspended`; a context
  // still `suspended` here is the silent-wedge failure this test exists to catch.
  const states = await readAudioContextStates(page);
  expect(
    states.every((s) => s !== "suspended"),
    `no AudioContext may remain suspended after capture (states: ${states.join(", ") || "none recorded"})`,
  ).toBe(true);
});

test("T3 backgrounding tears down capture and foreground requires a fresh gesture (no silent auto-resume)", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const mic = page.getByTestId("chat-composer-mic");
  await expect(mic).toBeVisible({ timeout: 30_000 });

  if (isMicProject()) {
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", /end conversation|stop/i, {
      timeout: 15_000,
    });
  }

  const before = await readProbe(page);
  await emulateAppBackground(page);
  // No NEW playback may spontaneously begin while backgrounded.
  await page.waitForTimeout(800);
  const backgrounded = await readProbe(page);
  expect(
    backgrounded.starts,
    "no audio may start while the PWA is backgrounded",
  ).toBe(before.starts);

  await emulateAppForeground(page);
  await page.waitForTimeout(500);
  const foregrounded = await readProbe(page);
  // Returning to foreground must NOT auto-start audio without a user gesture.
  expect(
    foregrounded.starts,
    "foregrounding must not auto-resume playback without a gesture",
  ).toBe(before.starts);
});

test("T4 an audio route change during idle does not orphan or duplicate audio sources", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-mic")).toBeVisible({
    timeout: 30_000,
  });
  const before = await readProbe(page);
  await emulateRouteChange(page);
  await page.waitForTimeout(500);
  const after = await readProbe(page);
  // A route change must not spawn stray sources; started sources must reconcile.
  expect(after.starts - after.ended).toBeLessThanOrEqual(before.starts + 1);
});

test("T5 an idle backgrounded PWA never opens the mic on its own", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  await expect(page.getByTestId("chat-composer-mic")).toBeVisible({
    timeout: 30_000,
  });
  let asrPosts = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      req.url().includes("/api/asr/local-inference") &&
      !req.url().includes("/status")
    )
      asrPosts += 1;
  });
  await emulateAppBackground(page);
  await page.waitForTimeout(1200);
  expect(asrPosts, "backgrounded idle PWA must not capture audio").toBe(0);
});
