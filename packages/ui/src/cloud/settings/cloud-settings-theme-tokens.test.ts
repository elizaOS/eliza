/**
 * Cloud settings token regression test. Lifted Cloud settings views must remain
 * readable in both light and dark app shells, so this static scan rejects
 * dark-island utility classes on the shared settings surfaces.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));

const SCANNED_PATHS = [
  "account-security",
  "organization",
  "billing/components",
  "connectors/discord-gateway-connection.tsx",
  "connectors/telegram-connection.tsx",
  "api-keys/ApiKeysView.tsx",
];

const FORBIDDEN_THEME_LOCKED_CLASSES = [
  "text-white",
  "text-white/",
  "divide-white",
  "bg-white/10",
  "bg-white/5",
  "bg-white/30",
  "bg-white/[",
  "border-white/10",
  "border-white/15",
  "border-white/20",
  "bg-black/40",
  "bg-black/60",
  "bg-black/90",
  "bg-[rgba(10,10,10,0.75)]",
  "bg-[#1a1a1a]",
  "bg-neutral-950",
];

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

describe("Cloud settings theme tokens", () => {
  it("keeps lifted Cloud settings bodies readable without a dark theme island", () => {
    const offenders: string[] = [];

    for (const file of SCANNED_PATHS.flatMap(collectFiles)) {
      if (ALLOWED_EXPLICIT_BLACK_CONTROLS.has(file)) continue;

      const source = readFileSync(join(ROOT, file), "utf8");
      for (const token of FORBIDDEN_THEME_LOCKED_CLASSES) {
        if (source.includes(token)) offenders.push(`${file}: ${token}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
