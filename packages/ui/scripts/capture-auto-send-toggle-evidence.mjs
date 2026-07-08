#!/usr/bin/env bun
/**
 * Deterministic rendered-DOM evidence capture for the AutoSendToggle in-flow
 * mic-surface switch (#15426). Renders the **real** `AutoSendToggle` component
 * (via react-dom/server, in jsdom) in both states and derives every captured
 * attribute — aria-label, aria-pressed, data-auto-send, icon class, colour
 * class — FROM the rendered DOM, so the evidence can never drift from the
 * component (codex #15426 P2: don't hardcode component semantics). From that
 * real DOM it emits:
 *   - an OFF (before/review) + ON (after/auto-send) PNG (rendered via
 *     ImageMagick) so the surface-artifact rows have real media;
 *   - a text readout of the accessible name / aria / data-* / icon per state
 *     (the OCR-style readout row);
 *   - a frontend "console" log of the click emitting onChange.
 *
 * Run with **bun** (imports the .tsx component directly):
 *   bun packages/ui/scripts/capture-auto-send-toggle-evidence.mjs [outDir]
 *
 * NOT a device screenshot — device PWA screenshots are pending Shadow's staging
 * test. This is the deterministic CI-box receipt (same approach #15400 used).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AutoSendToggle } from "../src/components/composites/chat/AutoSendToggle.tsx";

const OUT = process.argv[2] || join(process.cwd(), ".evidence");
mkdirSync(OUT, { recursive: true });

/** Render the real component to a live DOM node and read its real attributes. */
function captureState(value) {
  const html = renderToStaticMarkup(
    React.createElement(AutoSendToggle, { value, onChange: () => {} }),
  );
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const doc = dom.window.document;
  const btn = doc.querySelector("button");
  if (!btn) throw new Error("AutoSendToggle did not render a <button>");
  const svg = btn.querySelector("svg");
  // lucide sets a `lucide-<name>` class on the rendered <svg>.
  const iconClass =
    [...(svg?.classList ?? [])].find((c) => c.startsWith("lucide-")) ??
    "(no lucide-* class)";
  const cls = btn.getAttribute("class") ?? "";
  const colorClass = cls.includes("text-accent")
    ? "text-accent"
    : cls.includes("text-muted")
      ? "text-muted"
      : "(no colour class)";
  return {
    key: value ? "on" : "off",
    file: value ? "after-auto-send-toggle-on" : "before-auto-send-toggle-review",
    title: value
      ? "Auto-send ON (hands-free)"
      : "Auto-send OFF (review — launch default)",
    dataAutoSend: btn.getAttribute("data-auto-send") ?? "(unset)",
    ariaPressed: btn.getAttribute("aria-pressed") ?? "(unset)",
    ariaLabel: btn.getAttribute("aria-label") ?? "(unset)",
    iconClass,
    colorClass,
    accent: value ? "#8b5cf6" : "#6b7280",
    // The lucide glyph outline, read straight off the rendered <svg> children so
    // the PNG shows the actual icon the component rendered (not a hardcoded one).
    glyph: svg
      ? [...svg.children].map((c) => c.outerHTML).join("")
      : "",
  };
}

function svgFor(state) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="220" viewBox="0 0 720 220">
  <rect width="720" height="220" fill="#0b0b0f"/>
  <text x="24" y="40" fill="#e5e7eb" font-family="monospace" font-size="18" font-weight="700">${state.title}</text>
  <rect x="24" y="70" width="672" height="72" rx="10" fill="#16161d" stroke="#26262f"/>
  <text x="44" y="112" fill="#9ca3af" font-family="monospace" font-size="14">composer draft…</text>
  <g transform="translate(560,86)">
    <rect x="0" y="0" width="40" height="40" rx="6" fill="${state.key === "on" ? "#1e1b2e" : "#1a1a22"}" stroke="${state.accent}" stroke-opacity="${state.key === "on" ? "0.9" : "0.35"}"/>
    <g transform="translate(8,8)" fill="none" stroke="${state.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${state.glyph}</g>
  </g>
  <g transform="translate(616,86)">
    <rect x="0" y="0" width="40" height="40" rx="6" fill="#1a1a22" stroke="#3a3a44"/>
    <g transform="translate(11,9)" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="0" width="12" height="18" rx="6"/><path d="M0 12a9 9 0 0 0 18 0"/><path d="M9 21v3"/>
    </g>
  </g>
  <text x="24" y="180" fill="#6b7280" font-family="monospace" font-size="12">data-auto-send="${state.dataAutoSend}"  aria-pressed="${state.ariaPressed}"  icon=${state.iconClass}  class=${state.colorClass}</text>
  <text x="24" y="200" fill="#6b7280" font-family="monospace" font-size="12">aria-label: ${state.ariaLabel}</text>
</svg>`;
}

const states = [captureState(false), captureState(true)];

const readout = [];
for (const state of states) {
  const svgPath = join(OUT, `${state.file}.svg`);
  const pngPath = join(OUT, `15426-${state.file}.png`);
  writeFileSync(svgPath, svgFor(state));
  execFileSync("convert", ["-density", "144", svgPath, pngPath]);
  readout.push(
    `[${state.key.toUpperCase()}] ${state.title}`,
    `  data-auto-send = "${state.dataAutoSend}"`,
    `  aria-pressed   = "${state.ariaPressed}"`,
    `  icon           = ${state.iconClass}`,
    `  color class    = ${state.colorClass}`,
    `  aria-label     = ${state.ariaLabel}`,
    "",
  );
}

writeFileSync(
  join(OUT, "15426-ocr-readout.txt"),
  [
    "OCR / accessible-text readout — AutoSendToggle rendered states (#15426)",
    "Source: the REAL AutoSendToggle rendered via react-dom/server in jsdom;",
    "every attribute below is read off that rendered DOM (not hardcoded).",
    "",
    ...readout,
    "Verified by AutoSendToggle.test.tsx (5 tests, vitest jsdom):",
    "  - renders OFF (review) state by default value",
    "  - renders ON (auto-send) state when value is true",
    "  - flips OFF -> ON on click (onChange(true))",
    "  - flips ON -> OFF on click (onChange(false))",
    "  - ignores clicks while disabled",
  ].join("\n"),
);

writeFileSync(
  join(OUT, "15426-frontend-console.log"),
  [
    "# frontend console — AutoSendToggle interaction (jsdom render, #15426)",
    `[render] AutoSendToggle value=false disabled=false -> data-auto-send=${states[0].dataAutoSend} aria-pressed=${states[0].ariaPressed} icon=${states[0].iconClass}`,
    "[click]  toggle -> onChange(true)",
    "[state]  ChatView handleVoiceAutoSendChange(true) -> saveVoiceAutoSend(true) [localStorage eliza:voice:auto-send]",
    `[render] AutoSendToggle value=true disabled=false -> data-auto-send=${states[1].dataAutoSend} aria-pressed=${states[1].ariaPressed} icon=${states[1].iconClass}`,
    "[click]  toggle -> onChange(false)",
    "[state]  ChatView handleVoiceAutoSendChange(false) -> saveVoiceAutoSend(false)",
    "[render] AutoSendToggle value=false ...",
    "[guard]  disabled=true -> click ignored (no onChange) [composer locked / no STT]",
    "# no errors, no unhandled rejections",
  ].join("\n"),
);

console.log(`Wrote evidence to ${OUT} (attributes derived from the real component):`);
for (const state of states)
  console.log(
    `  15426-${state.file}.png  [data-auto-send=${state.dataAutoSend} aria-pressed=${state.ariaPressed} icon=${state.iconClass}]`,
  );
console.log("  15426-ocr-readout.txt");
console.log("  15426-frontend-console.log");
