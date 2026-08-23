/**
 * Gate asserting the chat-overlay shell entry-animation anchoring contract
 * (#20063 follow-up to #20496). Reads the stylesheets, no runtime.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the transient off-center fly-in lalalune confirmed as
 * the one residual finding from the #20496 review.
 *
 * The chat-overlay desktop shell centers its panel with
 * `transform: translateX(-50%)` (styles.css shell rule), and a CSS animation
 * REPLACES the transform property wholesale for its duration. The base
 * `shell-overlay-in` keyframes (used by the flex-centered login card, which
 * has NO translateX term to preserve) animate `translateY(...)` alone — so
 * when the shell's panel runs them, the centering term is dropped for the
 * whole 220ms entry and the panel flies in ~half its width off-center before
 * snapping back.
 *
 * The contract: base.css declares an `-anchored` variant carrying
 * `translateX(-50%)` through EVERY keyframe, and the shell rule in styles.css
 * overrides `animation-name` to select it (duration/easing still come from the
 * utility). The login page keeps the base keyframes (its card is centered via
 * flex `my-auto`, no translateX) and MUST stay unaffected: the override lives
 * only inside the `html.eliza-chat-overlay-shell` scoped rule.
 */
function readStyle(name: string): string {
  const raw = readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    "utf8",
  );
  // Strip CSS comments so their prose can't confuse brace matching below.
  return raw.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Extract the declaration block body for the first rule matching `selector`. */
function ruleBlock(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/** Extract the declaration block body between a keyframes selector's braces. */
function keyframesBlock(css: string, name: string): string {
  // The trailing whitespace boundary keeps "shell-overlay-in" from prefix-
  // matching "shell-overlay-in-anchored" (both blocks live in base.css).
  const marker = `@keyframes ${name} `;
  const at = css.indexOf(marker);
  if (at === -1) throw new Error(`@keyframes ${name} not found`);
  const open = css.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (i < css.length && depth > 0) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  return css.slice(open + 1, i - 1);
}

describe("chat-overlay shell entry-animation anchoring (#20063)", () => {
  const baseCss = readStyle("base.css");
  const stylesCss = readStyle("styles.css");
  const electrobunMacCss = readStyle("electrobun-mac-window-drag.css");

  it("declares shell-overlay-in-anchored keyframes carrying translateX(-50%) in every keyframe", () => {
    const anchored = keyframesBlock(baseCss, "shell-overlay-in-anchored");
    const frames = anchored.match(/transform:\s*([^;]+);/g) ?? [];
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(frame).toContain("translateX(-50%)");
    }
  });

  it("keeps the base shell-overlay-in keyframes translateY-only for the login card", () => {
    const base = keyframesBlock(baseCss, "shell-overlay-in");
    const frames = base.match(/transform:\s*([^;]+);/g) ?? [];
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const frame of frames) {
      expect(frame).not.toContain("translateX");
    }
  });

  it("overrides animation-name to the anchored variant only inside the chat-overlay shell rule", () => {
    const shell = ruleBlock(
      stylesCss,
      "html.eliza-chat-overlay-shell .shell-assistant-overlay-panel",
    );
    expect(shell).toContain("animation-name: shell-overlay-in-anchored");
    // The override must be scoped: the unscoped stylesheet outside the shell
    // rule must not re-declare the animation name anywhere else.
    const otherRules = stylesCss.replace(
      /html\.eliza-chat-overlay-shell \.shell-assistant-overlay-panel\s*\{[^}]*\}/,
      "",
    );
    expect(otherRules).not.toContain("shell-overlay-in-anchored");
    // base.css owns the keyframes themselves and nothing else: a second
    // reference there (e.g. an animation shorthand on an unrelated rule)
    // would leak the X-carrying keyframes to a non-centered element.
    const baseOccurrences = baseCss.match(/shell-overlay-in-anchored/g);
    expect(baseOccurrences?.length).toBe(1);
  });

  it("keeps the shell's centering transform and translate reset intact (#20105)", () => {
    const shell = ruleBlock(
      stylesCss,
      "html.eliza-chat-overlay-shell .shell-assistant-overlay-panel",
    );
    expect(shell).toContain("translate: none !important");
    expect(shell).toContain("transform: translateX(-50%)");
  });

  it("keeps every detached overlay root canvas force-transparent", () => {
    const rootCanvas = stylesCss.match(
      /html\.eliza-chat-overlay-shell,\s*html\.eliza-chat-overlay-shell body,\s*html\.eliza-chat-overlay-shell #root\s*\{[^}]*\}/,
    );
    expect(rootCanvas?.[0]).toContain("background: transparent !important");
  });

  it("reserves native titlebar space after a managed Workspace cleans its URL", () => {
    const stablePlatformSelector =
      /html\.eliza-electrobun-macos-titlebar:not\(\.eliza-electrobun-custom-titlebar\)\s+body\s*\{[^}]*padding-top:\s*var\(--eliza-macos-native-titlebar-height\)/;
    expect(electrobunMacCss).toMatch(stablePlatformSelector);
    expect(electrobunMacCss).toMatch(
      /html\.eliza-electrobun-macos-titlebar:not\(\.eliza-electrobun-custom-titlebar\)\s+#root\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*var\(--eliza-macos-native-titlebar-height\)\)/,
    );
    expect(electrobunMacCss).not.toMatch(
      /html\.eliza-electrobun-managed-window\s+body\s*\{[^}]*padding-top/,
    );
  });
});
