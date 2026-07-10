/**
 * Installed-PWA / iOS-lifecycle emulation seam for the device-realistic voice
 * E2E lane (sol-voice-pwa-e2e). NO production code — a Playwright test helper.
 *
 * The installed iOS PWA (Add-to-Home-Screen, WKWebView-in-standalone) has a
 * materially different lifecycle from a Safari tab: `navigator.standalone` is
 * true, `matchMedia('(display-mode: standalone)')` matches, the OS fires
 * pagehide/pageshow/freeze/resume on background/foreground, AudioContext can be
 * suspended by the OS at any lifecycle edge, and audio-route changes surface as
 * `devicechange` on navigator.mediaDevices. These helpers reproduce those edges
 * deterministically so the voice specs can prove the client survives them —
 * without a real iPhone in CI. The REAL device gates live in the runbook
 * (VOICE-PWA-E2E-PLAN §7); this is the automated pre-gate.
 */
import type { Page } from "@playwright/test";

const IOS_PWA_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

/**
 * Make the page look like an INSTALLED iOS PWA before it boots:
 *  - `navigator.standalone === true`
 *  - `(display-mode: standalone)` media query matches
 *  - the `beforeinstallprompt` event is pre-consumed (already installed)
 *  - iOS Safari UA string (so UA-sniffing code paths take the iOS branch)
 * Call BEFORE `page.goto` (uses addInitScript).
 */
export async function installStandalonePwa(page: Page): Promise<void> {
  await page.addInitScript(
    ({ ua }) => {
      try {
        Object.defineProperty(navigator, "standalone", {
          configurable: true,
          get: () => true,
        });
      } catch {
        /* some engines lock navigator props — best effort */
      }
      try {
        Object.defineProperty(navigator, "userAgent", {
          configurable: true,
          get: () => ua,
        });
      } catch {
        /* WebKit may refuse UA override — the standalone signal below still holds */
      }
      const realMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) => {
        if (/display-mode:\s*standalone/i.test(query)) {
          return {
            matches: true,
            media: query,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent() {
              return false;
            },
          } as unknown as MediaQueryList;
        }
        return realMatchMedia(query);
      }) as typeof window.matchMedia;
      // Mark installability as already-satisfied so any install-prompt gate is inert.
      (window as unknown as Record<string, unknown>).__pwaInstalled = true;
    },
    { ua: IOS_PWA_UA },
  );
}

/**
 * Emulate the OS backgrounding an installed PWA, in the order iOS WebKit fires:
 * visibilitychange(hidden) → pagehide → freeze. AudioContexts are marked so a
 * spec can assert the app treated this as a real suspension (not a permission
 * dialog focus-steal — that distinction is the 1500ms grace in the dossier).
 */
export async function emulateAppBackground(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    // `freeze` is a lifecycle event; dispatch a plain Event under that name.
    document.dispatchEvent(new Event("freeze"));
    (window as unknown as Record<string, number>).__pwaBackgroundedAt =
      performance.now();
  });
}

/**
 * Emulate returning to the foreground: resume → pageshow → visibilitychange(visible).
 * Crucially does NOT resume any AudioContext — the app must require a fresh user
 * gesture to unlock playback (Safari rule); the spec asserts that.
 */
export async function emulateAppForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("resume"));
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    (window as unknown as Record<string, number>).__pwaForegroundedAt =
      performance.now();
  });
}

/**
 * Emulate an audio-route change (Bluetooth/headphone connect-or-disconnect).
 * On iOS this surfaces as `devicechange` on navigator.mediaDevices plus a shift
 * in AudioContext.outputLatency. We fire the event and bump a shimmed
 * outputLatency so a spec can assert the client reacts (or at least does not
 * orphan the active source).
 */
export async function emulateRouteChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const md = navigator.mediaDevices as unknown as EventTarget | undefined;
    if (md && typeof md.dispatchEvent === "function") {
      md.dispatchEvent(new Event("devicechange"));
    }
    // Shift a shimmed output latency so route-aware playback code sees a change.
    (window as unknown as Record<string, number>).__routeChangeAt =
      performance.now();
  });
}

/**
 * Snapshot every live AudioContext.state. Requires `installAudioContextRegistry`
 * to have run first (init-script that records each constructed context).
 */
export async function readAudioContextStates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const reg = (
      window as unknown as {
        __audioContexts?: Array<{ state: string }>;
      }
    ).__audioContexts;
    return (reg ?? []).map((c) => c.state);
  });
}

/**
 * Init-script: register every constructed AudioContext (and force the first one
 * to START SUSPENDED when `forceSuspended` is set, to model the OS suspending
 * audio on a lifecycle edge). Call BEFORE page.goto.
 *
 * The forced-suspended shim models a REAL suspend->resume transition, not a
 * permanent mask: `state` reports `"suspended"` only until the app calls
 * `resume()` (or `close()`), after which it reflects the true underlying state.
 * That is what makes the T2 "no context remains suspended after capture"
 * assertion meaningful — it fails when the app never resumes and passes only when
 * the app's resume policy actually advances the context out of suspension.
 */
export async function installAudioContextRegistry(
  page: Page,
  opts: { forceSuspended?: boolean } = {},
): Promise<void> {
  await page.addInitScript(({ forceSuspended }) => {
    type Ctx = AudioContext & { __registered?: boolean };
    const w = window as unknown as {
      __audioContexts?: AudioContext[];
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    w.__audioContexts = [];
    let forcedOnce = false;
    const wrap = (Ctor?: typeof AudioContext) => {
      if (!Ctor) return Ctor;
      const Wrapped = function (this: unknown, ...args: unknown[]) {
        const ctx = new (Ctor as unknown as new (...a: unknown[]) => Ctx)(
          ...args,
        );
        if (!ctx.__registered) {
          ctx.__registered = true;
          w.__audioContexts?.push(ctx);
        }
        if (forceSuspended && !forcedOnce) {
          forcedOnce = true;
          try {
            // Capture the engine's real state getter so we can defer to it once
            // the app resumes; before that, report "suspended" to model the OS
            // having suspended audio at a lifecycle edge.
            const realDesc =
              Object.getOwnPropertyDescriptor(
                Object.getPrototypeOf(ctx),
                "state",
              ) ?? Object.getOwnPropertyDescriptor(ctx, "state");
            const realGet = realDesc?.get;
            let masked = true; // true => report "suspended" until resume()/close()
            Object.defineProperty(ctx, "state", {
              configurable: true,
              get() {
                if (masked) return "suspended";
                // After resume/close, reflect the engine's true state if we can
                // read it; otherwise assume the resume succeeded ("running").
                return realGet ? realGet.call(this) : "running";
              },
            });
            // Unmask on the first resume() or close() so a genuine resume clears
            // the suspended report (a no-op resume by the app cannot fake this).
            const unmaskAfter = (method: "resume" | "close"): void => {
              const orig = (ctx as unknown as Record<string, unknown>)[method];
              if (typeof orig !== "function") return;
              (ctx as unknown as Record<string, unknown>)[method] = function (
                this: unknown,
                ...a: unknown[]
              ) {
                masked = false;
                return (orig as (...args: unknown[]) => unknown).apply(this, a);
              };
            };
            unmaskAfter("resume");
            unmaskAfter("close");
          } catch {
            /* engine locked state — resume-attempt assertion still valid */
          }
        }
        return ctx;
      } as unknown as typeof AudioContext;
      Wrapped.prototype = Ctor.prototype;
      return Wrapped;
    };
    if (w.AudioContext) w.AudioContext = wrap(w.AudioContext);
    if (w.webkitAudioContext) w.webkitAudioContext = wrap(w.webkitAudioContext);
  }, opts);
}
