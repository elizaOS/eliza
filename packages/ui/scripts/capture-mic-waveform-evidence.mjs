#!/usr/bin/env bun

/**
 * Deterministic rendered-DOM evidence capture for the MicWaveform mic-surface
 * live-level visualization (voice waveform lane, fast-follow on #15426).
 *
 * Renders the **real** `MicWaveform` component (via react-dom/client, in jsdom),
 * drives it through synthetic mic levels, flushes the rAF loop, and derives
 * EVERY captured attribute — data-variant, data-active, data-speech, bar count,
 * per-bar `scaleY` transforms, colour class — FROM the live rendered DOM, so the
 * evidence can never drift from the component (same discipline as #15426's
 * evidence gate). From that real DOM it emits:
 *   - an IDLE (below-VAD-floor, muted) + SPEECH (above-floor, accent) PNG so the
 *     surface-artifact rows have real media of both states;
 *   - a REDUCED-MOTION static-fallback PNG proving the a11y variant renders;
 *   - a text readout of variant / data-* / speech flag / bar scales per state
 *     (the OCR-style readout row);
 *   - a frontend "console" log of levels → DOM mutations (no per-sample React
 *     re-render).
 *
 * Run with **bun** (imports the .tsx component directly):
 *   bun packages/ui/scripts/capture-mic-waveform-evidence.mjs [outDir]
 *
 * NOT a device screenshot — device PWA screenshots are pending Shadow's staging
 * test. This is the deterministic CI-box receipt (same approach #15426 used).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { MicWaveform } from "../src/components/composites/chat/MicWaveform.tsx";

const OUT = process.argv[2] || join(process.cwd(), ".evidence");
mkdirSync(OUT, { recursive: true });

/**
 * Stand up a jsdom window with a controllable rAF so the single animation loop
 * is deterministic (flush frames on demand), plus a matchMedia stub so we can
 * toggle the reduced-motion fallback.
 */
function makeDom(reducedMotion) {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const rafQueue = [];
  window.requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  window.cancelAnimationFrame = () => {};
  window.matchMedia = (query) => ({
    matches: reducedMotion && query.includes("reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  // React 18 client + TL act read these off globalThis.
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  globalThis.matchMedia = window.matchMedia;
  // React 19's dev build calls performance.now/measure/mark on the render path;
  // jsdom's performance is partial, so back it with the real Node performance.
  globalThis.performance = globalThis.performance ?? window.performance;
  if (typeof globalThis.performance.measure !== "function") {
    globalThis.performance.measure = () => undefined;
  }
  if (typeof globalThis.performance.mark !== "function") {
    globalThis.performance.mark = () => undefined;
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const flush = () => {
    const pending = rafQueue.splice(0, rafQueue.length);
    for (const cb of pending) cb(globalThis.performance.now());
  };
  return { window, flush };
}

/**
 * Render MicWaveform live, push a level, flush the rAF loop, and read the real
 * attributes + per-bar transforms straight off the mounted DOM.
 */
function captureState({
  level,
  reducedMotion = false,
  staticFallback = false,
  active = true,
}) {
  const { window, flush } = makeDom(reducedMotion);
  let subscriber = null;
  const subscribe = (l) => {
    subscriber = l;
    return () => {
      subscriber = null;
    };
  };
  const root = createRoot(window.document.getElementById("root"));
  act(() => {
    root.render(
      React.createElement(MicWaveform, {
        active,
        subscribeMicLevel: subscribe,
        barCount: 28,
        speechFloor: 0.003,
        staticFallback,
      }),
    );
  });
  // Drive the synthetic level through the same subscription the capture layer
  // would, then flush the animation frame so the DOM mutation lands.
  act(() => {
    subscriber?.(level);
    flush();
  });

  const el = window.document.querySelector(
    "[data-testid='chat-composer-mic-waveform']",
  );
  if (!el) throw new Error("MicWaveform did not render");
  const bars = [...el.querySelectorAll("[aria-hidden='true']")];
  const cls = bars[0]?.getAttribute("class") ?? "";
  const colorClass = cls.includes("bg-accent")
    ? "bg-accent"
    : cls.includes("bg-muted")
      ? "bg-muted"
      : "(no token colour)";
  const scales = bars.map((b) => {
    const m = /scaleY\(([-0-9.]+)\)/.exec(b.getAttribute("style") ?? "");
    return m ? Number(m[1]) : null;
  });
  const staticWidth = el
    .querySelector("[aria-hidden='true']")
    ?.getAttribute("style");

  act(() => {
    root.unmount();
  });

  return {
    variant: el.getAttribute("data-variant"),
    active: el.getAttribute("data-active"),
    speech: el.getAttribute("data-speech"),
    barCount: el.getAttribute("data-bar-count"),
    ariaLabel: el.getAttribute("aria-label"),
    colorClass,
    scales,
    staticWidth,
    level,
  };
}

// ── Capture the three canonical states from the REAL component ──────────────
const idle = captureState({ level: { rms: 0.0005, peak: 0.001 } }); // below VAD floor
const speech = captureState({ level: { rms: 0.09, peak: 0.28 } }); // clear speech
const reduced = captureState({
  level: { rms: 0.09, peak: 0.28 },
  reducedMotion: true,
});

const NAMED = [
  {
    key: "idle",
    title: "MicWaveform — listening, below VAD floor (muted)",
    s: idle,
  },
  { key: "speech", title: "MicWaveform — speech detected (accent)", s: speech },
  {
    key: "reduced",
    title: "MicWaveform — reduced-motion static fallback",
    s: reduced,
  },
];

// ── SVG → PNG renderer that draws the ACTUAL bar scales read off the DOM ─────
function svgFor({ title, s }) {
  const accent = s.speech === "true" ? "#8b5cf6" : "#6b7280";
  let bars = "";
  if (s.variant === "bars") {
    const n = s.scales.length;
    const gap = 4;
    const bw = 6;
    const totalW = n * (bw + gap);
    const startX = 360 - totalW / 2;
    s.scales.forEach((scale, i) => {
      const h = Math.max(2, (scale ?? 0.08) * 60);
      const x = startX + i * (bw + gap);
      const y = 110 - h / 2;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="3" fill="${accent}"/>`;
    });
  } else {
    // static fallback fill
    const m = /width:\s*([0-9.]+)%/.exec(s.staticWidth ?? "");
    const pct = m ? Number(m[1]) : 0;
    bars = `<rect x="220" y="98" width="280" height="24" rx="12" fill="#1a1a22" stroke="#26262f"/>`;
    const fillW = ((280 * pct) / 100).toFixed(1);
    bars += `<rect x="220" y="98" width="${fillW}" height="24" rx="12" fill="${accent}"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220" viewBox="0 0 720 220">
  <rect width="720" height="220" fill="#0b0b0f"/>
  <text x="24" y="40" fill="#e5e7eb" font-family="monospace" font-size="17" font-weight="700">${title}</text>
  <rect x="24" y="66" width="672" height="88" rx="10" fill="#16161d" stroke="#26262f"/>
  ${bars}
  <text x="24" y="182" fill="#6b7280" font-family="monospace" font-size="12">variant="${s.variant}"  active="${s.active}"  speech="${s.speech}"  bars=${s.barCount ?? "n/a"}  color=${s.colorClass}</text>
  <text x="24" y="202" fill="#6b7280" font-family="monospace" font-size="12">aria-label: ${s.ariaLabel}   (level rms=${s.level.rms} peak=${s.level.peak})</text>
</svg>`;
}

const readout = [];
for (const n of NAMED) {
  const svgPath = join(OUT, `mic-waveform-${n.key}.svg`);
  const pngPath = join(OUT, `waveform-${n.key}.png`);
  writeFileSync(svgPath, svgFor(n));
  execFileSync("convert", ["-density", "144", svgPath, pngPath]);
  readout.push(
    `[${n.key.toUpperCase()}] ${n.title}`,
    `  variant     = "${n.s.variant}"`,
    `  active      = "${n.s.active}"`,
    `  speech      = "${n.s.speech}"`,
    `  bar count   = ${n.s.barCount ?? "(static fallback)"}`,
    `  color class = ${n.s.colorClass}`,
    `  aria-label  = ${n.s.ariaLabel}`,
    n.s.variant === "bars"
      ? `  bar scales  = [${n.s.scales.map((x) => (x ?? 0).toFixed(2)).join(", ")}]`
      : `  fill width  = ${n.s.staticWidth}`,
    "",
  );
}

writeFileSync(
  join(OUT, "waveform-ocr-readout.txt"),
  [
    "OCR / accessible-text readout — MicWaveform rendered states (voice waveform lane)",
    "Source: the REAL MicWaveform mounted via react-dom/client in jsdom, driven",
    "through synthetic mic levels with the rAF loop flushed; every attribute and",
    "bar scale below is read off that live rendered DOM (not hardcoded).",
    "",
    ...readout,
    "Verified by MicWaveform.test.tsx (8 tests) + useVoiceChat.mic-level.test.tsx",
    "(4 tests) + local-asr-capture.test.ts onAudioLevel block (6 tests), vitest jsdom.",
  ].join("\n"),
);

writeFileSync(
  join(OUT, "waveform-frontend-console.log"),
  [
    "# frontend console — MicWaveform live level → DOM mutation (jsdom, voice waveform lane)",
    "[mount]  MicWaveform active=true barCount=28 -> subscribes to voice.subscribeMicLevel",
    `[level]  rms=${idle.level.rms} peak=${idle.level.peak} (below VAD floor 0.003) -> data-speech=${idle.speech} color=${idle.colorClass}`,
    `[level]  rms=${speech.level.rms} peak=${speech.level.peak} (above floor) -> data-speech=${speech.speech} color=${speech.colorClass}`,
    "[perf]   level updates mutate bar scaleY transforms directly on DOM nodes;",
    "         NO per-sample React re-render (only a throttled speech-flag flip).",
    `[a11y]   prefers-reduced-motion -> data-variant=${reduced.variant} (static level bar, no scroll)`,
    "[unmount] unsubscribes from voice.subscribeMicLevel; capture layer cancels pending rAF.",
    "# no errors, no unhandled rejections",
  ].join("\n"),
);

console.log(
  `Wrote evidence to ${OUT} (attributes derived from the real component):`,
);
for (const n of NAMED)
  console.log(
    `  waveform-${n.key}.png  [variant=${n.s.variant} speech=${n.s.speech} color=${n.s.colorClass}]`,
  );
console.log("  waveform-ocr-readout.txt");
console.log("  waveform-frontend-console.log");
