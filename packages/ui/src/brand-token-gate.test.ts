/**
 * Source-scanning gate for the black/white/orange brand contract. Encodes the
 * violation classes found by the dynamic Storybook audits (#25901, #26066,
 * #26075, #26117) so regressions are caught in code without a browser crawl:
 * banned blue/purple/cyan utilities, Binance-gold literals, and the retired
 * first-run text-support scrim plate. Reads the src tree, no runtime.
 *
 * Off-token status colors (red/green/amber utilities) and raw hex literals are
 * tracked as a ratcheting BASELINE rather than a flat ban: the count may only
 * go down. Burn-down happens surface-by-surface (see the audit workflow in
 * #26117); a PR that adds a new off-token color fails immediately, and a PR
 * that cleans a surface updates the baseline downward.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = import.meta.dirname;

// ── Class B1: banned hue families (hard ban, stories included) ─────────
// The brand contract bans blue and purple outright; cyan/teal reads as blue
// on the dark canvas. Exemptions are deliberate product decisions only.
const BANNED_HUE =
  /(?:^|[\s"'`{:!])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|shadow|decoration|caret|accent)-(?:blue|indigo|sky|violet|purple|fuchsia|cyan)-\d+/g;

// Deliberate exemptions: external brand colors and the code syntax palette
// render third-party or editor-conventional hues by design.
const BANNED_HUE_EXEMPT_FILES = new Set([
  // VS Code Dark+ syntax palette — editor convention, pending design ruling.
  "cloud-ui/components/code/code-display.tsx",
  // Discord/Telegram/LinkedIn brand colors on connection surfaces.
  "cloud-ui/components/promotion/social-connection-hint.tsx",
]);

// ── Class B7: Binance-gold remnants (hard ban) ─────────────────────────
// #f0b90b and friends are the retired gold palette. They may appear only in
// styles/brand-gold.css (the token source) and themes/presets.ts (the theme
// preset catalog, which legitimately describes the gold preset).
const GOLD_LITERAL = /240,\s*185,\s*11|#f0b90b|#f3ba2f|#e9b52c|#d8a000/gi;
const GOLD_EXEMPT_FILES = new Set([
  "styles/brand-gold.css",
  "themes/presets.ts",
]);

// ── Class B6: retired scrim plate (hard ban) ───────────────────────────
// The first-run text-support plate boxed subheadlines on flat dark shells
// (#26117 review). The token and its class are deleted; nothing may recreate
// either.
const SCRIM_PLATE = /--first-run-text-support|setupTextSupportClassName/g;

// ── Ratcheted classes: count may only decrease ─────────────────────────
// Off-token status utilities bypass --status-success/--destructive/--warn.
const OFF_TOKEN_STATUS =
  /(?:^|[\s"'`{:!])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|rose|pink|green|emerald|teal|lime|yellow|amber)-\d+/g;

// Baselines from the #26117-era scan (2026-08-23). Ratchet DOWN only: when a
// burn-down PR cleans a surface, lower the number. Never raise one — add the
// new color through the semantic tokens instead.
const OFF_TOKEN_STATUS_BASELINE = 325;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(tsx?|css)$/.test(name) && !name.includes(".spec.")) {
      out.push(full);
    }
  }
  return out;
}

const GATE_FILE = "brand-token-gate.test.ts";

function relativePath(file: string): string {
  return file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
}

function isTestFile(relative: string): boolean {
  return relative.includes(".test.") || relative.includes("__tests__");
}

function scan(
  pattern: RegExp,
  options: {
    exemptFiles?: Set<string>;
    includeTests?: boolean;
    includeStories?: boolean;
  } = {},
): string[] {
  const offenders: string[] = [];
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const relative = relativePath(file);
    if (relative === GATE_FILE) continue;
    if (options.exemptFiles?.has(relative)) continue;
    if (!options.includeTests && isTestFile(relative)) continue;
    if (!options.includeStories && relative.includes(".stories.")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trimStart();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        continue;
      }
      pattern.lastIndex = 0;
      for (const match of lines[index].matchAll(pattern)) {
        offenders.push(`${relative}:${index + 1}:${match[0].trim()}`);
      }
    }
  }
  return offenders;
}

describe("brand token gate", () => {
  it("bans blue/purple/cyan utility classes outside deliberate exemptions", () => {
    const offenders = scan(BANNED_HUE, {
      exemptFiles: BANNED_HUE_EXEMPT_FILES,
      includeStories: true,
    });
    expect(
      offenders,
      `banned hue utilities found (brand is black/white/orange): ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("bans Binance-gold literals outside the token source and preset catalog", () => {
    const offenders = scan(GOLD_LITERAL, {
      exemptFiles: GOLD_EXEMPT_FILES,
      includeStories: true,
      includeTests: true,
    });
    expect(
      offenders,
      `retired gold palette literals found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("keeps the first-run text-support scrim plate deleted", () => {
    const offenders = scan(SCRIM_PLATE, {
      includeStories: true,
      includeTests: true,
    });
    expect(
      offenders,
      `the retired scrim plate resurfaced: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("ratchets off-token status utilities down toward the semantic tokens", () => {
    const offenders = scan(OFF_TOKEN_STATUS);
    expect(
      offenders.length,
      `off-token status utilities grew past the ratchet (${offenders.length} > ${OFF_TOKEN_STATUS_BASELINE}). ` +
        `Use text-status-success / bg-status-success-bg / text-destructive instead of raw palette colors. ` +
        `Newest offenders (tail): ${JSON.stringify(offenders.slice(-8))}`,
    ).toBeLessThanOrEqual(OFF_TOKEN_STATUS_BASELINE);
  });
});
