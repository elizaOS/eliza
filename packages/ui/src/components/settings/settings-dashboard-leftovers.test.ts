/**
 * Seconds-scale leftover catalog for settings-mounted dashboard BrandCards.
 * Replaces multi-minute explore scans: a new BrandCard in a settings-mounted
 * file must be allowlisted with a kind reason, or the test fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = resolve(import.meta.dirname);
const uiSrc = resolve(settingsRoot, "../..");

/**
 * Settings-mounted trees. A BrandCard here is either converted, pending a
 * known class PR, or an excluded different kind.
 */
const SETTINGS_MOUNTED_DIRS = [
  "cloud/account-security",
  "cloud/organization",
  "cloud/billing",
  "cloud/settings",
  "cloud/api-keys",
  "cloud/monetization",
  "cloud/connectors",
  "cloud/mcps",
  "cloud/applications",
  "components/settings",
];

/**
 * Remaining BrandCard hosts and why they are not a SettingsStack/Group/Row
 * leftover of the already-shipped classes. Remove a row when that file
 * converts; add a row only when introducing a new BrandCard on purpose.
 */
const BRANDCARD_ALLOWLIST = new Map<string, string>([
  [
    "cloud/billing/components/auto-top-up-card.tsx",
    "billing multi-field editor (switch + amounts + save)",
  ],
  [
    "cloud/billing/components/billing-tab.tsx",
    "credit hero + buy-credits form + invoice table",
  ],
  [
    "cloud/billing/components/invoice-detail-client.tsx",
    "invoice detail cards, not labelled settings rows",
  ],
  [
    "cloud/organization/organization-tab.tsx",
    "org hero tile + tabs; empty state already converted",
  ],
  [
    "cloud/monetization/affiliates/AffiliatesPageClient.tsx",
    "affiliates dashboard cards/tables",
  ],
  [
    "cloud/monetization/earnings/EarningsPageClient.tsx",
    "earnings dashboard cards/tables",
  ],
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name.startsWith("__")) {
        continue;
      }
      out.push(...listSourceFiles(full));
      continue;
    }
    if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".test.tsx") &&
      !name.endsWith(".stories.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("settings-mounted BrandCard leftover catalog", () => {
  const hits: { rel: string; allowlisted: boolean }[] = [];

  for (const dir of SETTINGS_MOUNTED_DIRS) {
    const abs = join(uiSrc, dir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of listSourceFiles(abs)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("BrandCard")) continue;
      const rel = relative(uiSrc, file).replaceAll("\\", "/");
      hits.push({ rel, allowlisted: BRANDCARD_ALLOWLIST.has(rel) });
    }
  }

  it("every settings-mounted BrandCard is a known leftover with a kind reason", () => {
    const unknown = hits
      .filter((hit) => !hit.allowlisted)
      .map((hit) => hit.rel);
    expect(unknown).toEqual([]);
  });

  it("allowlist entries still exist and still contain BrandCard", () => {
    const stale: string[] = [];
    for (const rel of BRANDCARD_ALLOWLIST.keys()) {
      const abs = join(uiSrc, rel);
      let source = "";
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        stale.push(`${rel} (missing)`);
        continue;
      }
      if (!source.includes("BrandCard"))
        stale.push(`${rel} (converted — remove allowlist)`);
    }
    expect(stale).toEqual([]);
  });

  it("prints the remaining catalog (not a gate)", () => {
    const remaining = [...BRANDCARD_ALLOWLIST.entries()].map(
      ([rel, reason]) => `${rel} — ${reason}`,
    );
    expect(remaining.length).toBeGreaterThan(0);
  });
});
