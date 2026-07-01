/**
 * Browser-side determinism shim for visual/story testing.
 *
 * Injected (via Playwright `page.addInitScript`) BEFORE any app code runs, so
 * every render is byte-stable across machines, time zones, and runs. This is
 * what lets story screenshots be diffed and a11y results be reproducible.
 *
 * What it pins:
 *  - `Date` / `Date.now()` -> a fixed epoch (no "2 seconds ago" drift).
 *  - `Math.random()` -> seeded mulberry32 PRNG (stable "random" layouts/ids).
 *  - `crypto.randomUUID()` -> deterministic counter-based uuids.
 *  - `Intl` + `toLocale*` -> en-US / UTC (locale- and tz-independent text).
 *  - `performance.now()` -> monotonic from 0 (stable perf-derived values).
 *  - CSS animations/transitions -> disabled (no mid-animation capture).
 *
 * It deliberately does NOT stub `requestAnimationFrame`/`setTimeout`: real
 * timers still run so interaction tests work; only the *values* components read
 * are frozen. Keep this function self-contained (no closures over module scope);
 * it is serialized and evaluated in the page.
 *
 * The fixed instant - 2025-06-01T12:00:00.000Z - is exported as
 * FROZEN_EPOCH_MS so server-side test setup can pin the same value.
 */

export const FROZEN_EPOCH_MS = 1748779200000; // 2025-06-01T12:00:00.000Z

export function determinismShim(frozenEpochMs) {
  const FIXED =
    typeof frozenEpochMs === "number" ? frozenEpochMs : 1748779200000;

  // The static Storybook catalog has no API backend. Seed the persisted UI
  // language so TranslationProvider treats the run as a returning visitor and
  // skips the best-effort /api/i18n/locale geo-suggestion request.
  try {
    if (!localStorage.getItem("eliza:ui-language")) {
      localStorage.setItem("eliza:ui-language", "en");
    }
  } catch {
    /* localStorage unavailable - non-fatal */
  }

  // ---- Date / Date.now -----------------------------------------------------
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(FIXED);
      } else {
        super(...args);
      }
    }
    static now() {
      return FIXED;
    }
  }
  // Preserve identity helpers callers rely on.
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  // biome-ignore lint/suspicious/noGlobalAssign: intentional test-time freeze
  Date = FixedDate;

  // ---- Math.random (mulberry32, fixed seed) --------------------------------
  let seed = 0x9e3779b9 >>> 0;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---- crypto.randomUUID (deterministic counter) ---------------------------
  try {
    let n = 0;
    const cryptoObj = globalThis.crypto || {};
    cryptoObj.randomUUID = () => {
      n += 1;
      const hex = n.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    };
    if (!globalThis.crypto) {
      Object.defineProperty(globalThis, "crypto", {
        value: cryptoObj,
        configurable: true,
      });
    }
  } catch {
    /* read-only crypto in some engines - non-fatal */
  }

  // ---- performance.now (monotonic from 0) ----------------------------------
  try {
    let perf = 0;
    if (globalThis.performance) {
      globalThis.performance.now = () => {
        perf += 16;
        return perf;
      };
    }
  } catch {
    /* non-fatal */
  }

  // ---- Intl + toLocale* -> en-US / UTC --------------------------------------
  const FIXED_LOCALE = "en-US";
  const withUtc = (opts) => ({ timeZone: "UTC", ...(opts || {}) });
  try {
    const RealDTF = Intl.DateTimeFormat;
    const PatchedDTF = function DateTimeFormat(_locale, opts) {
      return new RealDTF(FIXED_LOCALE, withUtc(opts));
    };
    PatchedDTF.prototype = RealDTF.prototype;
    PatchedDTF.supportedLocalesOf = RealDTF.supportedLocalesOf;
    Intl.DateTimeFormat = PatchedDTF;

    const RealNF = Intl.NumberFormat;
    const PatchedNF = function NumberFormat(_locale, opts) {
      return new RealNF(FIXED_LOCALE, opts);
    };
    PatchedNF.prototype = RealNF.prototype;
    PatchedNF.supportedLocalesOf = RealNF.supportedLocalesOf;
    Intl.NumberFormat = PatchedNF;
  } catch {
    /* non-fatal */
  }
  const DP = Date.prototype;
  const origToLocaleString = DP.toLocaleString;
  DP.toLocaleString = function (_l, o) {
    return origToLocaleString.call(this, FIXED_LOCALE, withUtc(o));
  };
  const origToLocaleDateString = DP.toLocaleDateString;
  DP.toLocaleDateString = function (_l, o) {
    return origToLocaleDateString.call(this, FIXED_LOCALE, withUtc(o));
  };
  const origToLocaleTimeString = DP.toLocaleTimeString;
  DP.toLocaleTimeString = function (_l, o) {
    return origToLocaleTimeString.call(this, FIXED_LOCALE, withUtc(o));
  };
  const NP = Number.prototype;
  const origNumToLocaleString = NP.toLocaleString;
  NP.toLocaleString = function (_l, o) {
    return origNumToLocaleString.call(this, FIXED_LOCALE, o);
  };

  // ---- Disable animations/transitions (no mid-animation captures) ----------
  const installAnimationKill = () => {
    const style = document.createElement("style");
    style.setAttribute("data-determinism-shim", "");
    style.textContent =
      "*,*::before,*::after{" +
      "animation-duration:0s !important;animation-delay:0s !important;" +
      "transition-duration:0s !important;transition-delay:0s !important;" +
      "caret-color:transparent !important;scroll-behavior:auto !important;}";
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.head || document.documentElement) {
    installAnimationKill();
  } else {
    document.addEventListener("DOMContentLoaded", installAnimationKill, {
      once: true,
    });
  }
}

/**
 * Serialized form for `page.addInitScript({ content })` contexts that cannot
 * pass a function (e.g. injecting into a plain HTML string).
 */
export function determinismShimSource(frozenEpochMs = FROZEN_EPOCH_MS) {
  return `(${determinismShim.toString()})(${JSON.stringify(frozenEpochMs)});`;
}
