/**
 * Regression guard for #13767: the lifted Eliza Cloud settings bodies must stay
 * readable on the LIGHT theme after #13755 removed the `theme-cloud bg-black`
 * island that used to wrap them (#13452 one-opaque-surface). The bodies used to
 * hardcode light-on-dark styling (`text-white`, `bg-[rgba(10,10,10,0.75)]`,
 * near-white/gray hexes, `divide-white/10`, …) that reads as white-on-white once
 * the dark island is gone. This test scans the section-body sources and fails on
 * any hardcoded theme-locked color, forcing the design-system tokens
 * (`text-txt`, `text-muted`, `bg-surface`, `border-border`, …) that resolve for
 * both themes instead.
 *
 * White/light text ON a solid saturated fill (the red destructive-action
 * buttons, `bg-[#EB4335] … text-white`) is legitimate — white-on-red is readable
 * in both themes and `text-primary-foreground` is NOT a substitute (`.theme-cloud`
 * maps it to brand-black). So the scan is per-className: a `text-white`-family
 * token is allowed only when its own className also carries a solid colored
 * background.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

const SCANNED_PATHS = [
  "account-security",
  // #14205 retokenized these two Settings surfaces after the #13755 audit
  // found ~170 hardcoded light-on-dark utilities; scanning them keeps the
  // fix regression-proof (the gap that let the drift accumulate unnoticed).
  "applications/components",
  "organization",
  "billing/components",
  "connectors/discord-gateway-connection.tsx",
  "connectors/telegram-connection.tsx",
  "api-keys/ApiKeysView.tsx",
  "mcps/McpEditorDialog.tsx",
];

const STATUS_TOKEN_FILES = [
  "account-security/components/active-sessions-panel.tsx",
  "account-security/components/mfa-panel.tsx",
  "account-security/components/privacy-panel.tsx",
  "organization/pending-invites-list.tsx",
];

// Theme-locked color utilities: hardcoded light-on-dark values that render
// white/near-white text or opaque dark surfaces regardless of the active theme.
const FORBIDDEN_TOKEN_PATTERNS: RegExp[] = [
  /\btext-white(?:\/[\w.[\]%]+)?\b/, // white body text (opacity-graded or not)
  /\bbg-white\/[\w.[\]%]+/, // translucent white fills
  /\bborder-white\/[\w.[\]%]+/,
  /\bdivide-white\/[\w.[\]%]+/,
  /\bbg-black(?:\/[\w.[\]%]+)?/, // opaque / translucent black surfaces
  /\bbg-neutral-800\b/,
  /\bbg-neutral-900\b/,
  /\bbg-\[rgba\(10,10,10/, // bespoke near-black panels
  /\bbg-\[rgba\(29,29,29/,
  /\bbg-\[#(?:1a1a1a|0b0d11)\]/,
  /\bbg-neutral-950\b/,
  /\btext-\[#(?:e1e1e1|858585|717171)\]/, // near-white / mid-gray text
  /\bborder-\[#303030\]/, // dark hairline borders
  /\bborder-\[rgba\(255,255,255/, // translucent white borders
];

// A `text-white`-family token is permitted when the same className also paints a
// solid saturated background (white-on-color reads in both themes).
const SOLID_COLOR_BG =
  /\bbg-(?:accent|primary|destructive|red-(?:5|6|7|8|9)00)\b|\bbg-\[#(?:eb4335|ff5800|e54f00)\]|\bbg-\[(?:rgba\()?var\(--accent/i;
const isWhiteTextToken = (pattern: RegExp) =>
  pattern.source.includes("text-white");

// direct-crypto-credit-card renders its explicit black/white cloud aesthetic only
// under an in-component `surface === "cloud"` branch, not on the settings surface.
const ALLOWED_EXPLICIT_BLACK_CONTROLS = new Set([
  "billing/components/direct-crypto-credit-card.tsx",
]);

function collectFiles(path: string): string[] {
  const fullPath = join(ROOT, path);
  if (statSync(fullPath).isFile()) return [path];

  return readdirSync(fullPath).flatMap((entry) => {
    const child = join(path, entry);
    const childFullPath = join(ROOT, child);
    if (statSync(childFullPath).isDirectory()) return collectFiles(child);
    return child.endsWith(".tsx") ? [child] : [];
  });
}

// Every quoted / backtick string literal in the file — className attributes,
// cn()/ternary class fragments, and `${…}`-nested class strings all surface here.
const STRING_LITERAL =
  /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

describe("Cloud settings theme tokens", () => {
  it("keeps lifted Cloud settings bodies readable without a dark theme island", () => {
    const offenders: string[] = [];

    for (const file of SCANNED_PATHS.flatMap(collectFiles)) {
      if (ALLOWED_EXPLICIT_BLACK_CONTROLS.has(file)) continue;

      const source = readFileSync(join(ROOT, file), "utf8");
      for (const match of source.matchAll(STRING_LITERAL)) {
        const classString = match[1] ?? match[2] ?? match[3] ?? "";
        const hasSolidColorBg = SOLID_COLOR_BG.test(classString);
        for (const pattern of FORBIDDEN_TOKEN_PATTERNS) {
          if (!pattern.test(classString)) continue;
          if (isWhiteTextToken(pattern) && hasSolidColorBg) continue;
          offenders.push(`${file}: ${pattern.source}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps account security status colors readable on light settings surfaces", () => {
    const offenders: string[] = [];
    const paleStatusTokens = /\b(?<!dark:)text-(?:red|green)-(?:300|400)\b/;

    for (const file of STATUS_TOKEN_FILES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const match of source.matchAll(STRING_LITERAL)) {
        const classString = match[1] ?? match[2] ?? match[3] ?? "";
        if (paleStatusTokens.test(classString)) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
