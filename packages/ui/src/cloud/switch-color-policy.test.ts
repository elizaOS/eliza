/**
 * Source guard for the three custom green ON-track Switch overrides.
 * Reads those files only; fails if green checked tracks, forced unchecked
 * neutrals, or dead `data-slot=switch-thumb` selectors return.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLOUD_ROOT = import.meta.dirname;

const GUARDED_FILES = [
  "applications/components/app-settings.tsx",
  "applications/components/app-monetization-settings.tsx",
  "instances/components/agent-card.tsx",
] as const;

const FORBIDDEN = [
  /data-\[state=checked\]:bg-green-500/,
  /data-\[state=unchecked\]:bg-neutral-700/,
  /data-slot=switch-thumb/,
] as const;

describe("cloud Switch green ON-track guard", () => {
  it("keeps the guarded files free of custom green ON / forced-OFF Switch classes", () => {
    const offenders: string[] = [];
    for (const rel of GUARDED_FILES) {
      const source = readFileSync(join(CLOUD_ROOT, rel), "utf8");
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${rel} matches ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still guards the live Switch call sites (no stale paths)", () => {
    for (const rel of GUARDED_FILES) {
      const source = readFileSync(join(CLOUD_ROOT, rel), "utf8");
      expect(source).toContain("<Switch");
    }
  });
});
