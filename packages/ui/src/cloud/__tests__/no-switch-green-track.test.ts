/**
 * Source ratchet guarding the shared Switch primitive's default track on the
 * three cloud call sites that previously forced a green ON / neutral OFF track
 * and dead `data-slot=switch-thumb` selectors. The shared Switch already
 * renders the correct accent-ON / input-OFF track, so these override strings
 * must never return. Reads files off disk — no render. Matches the specific
 * override strings, not a bare `bg-green-500`, so the legitimate non-Switch
 * container backgrounds in app-monetization-settings do not trip the ratchet.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cloudRoot = resolve(import.meta.dirname, "..");

/** Files that render the shared Switch and must keep its default track. */
const GUARDED_FILES = [
  "applications/components/app-settings.tsx",
  "applications/components/app-monetization-settings.tsx",
  "instances/components/agent-card.tsx",
] as const;

/**
 * Forbidden Switch override substrings. Each is a full override token so the
 * container `bg-green-500/10`, `bg-green-500/5`, and `border-green-500/20`
 * styling elsewhere in app-monetization-settings stays legitimate.
 */
const FORBIDDEN_SWITCH_OVERRIDES = [
  "data-[state=checked]:bg-green-500",
  "data-[state=unchecked]:bg-neutral-700",
  "data-slot=switch-thumb",
] as const;

function findForbidden(source: string): string[] {
  return FORBIDDEN_SWITCH_OVERRIDES.filter((needle) => source.includes(needle));
}

describe("cloud Switch call sites keep the shared default accent track", () => {
  it.each(GUARDED_FILES)(
    "%s contains no green ON / neutral OFF / switch-thumb Switch overrides",
    (relPath) => {
      const source = readFileSync(resolve(cloudRoot, relPath), "utf8");
      const hits = findForbidden(source);
      expect(
        hits.length === 0,
        hits.length > 0
          ? `${relPath} reintroduced forbidden Switch override(s): ${hits.join(", ")}. ` +
              `The shared Switch primitive already applies the default accent-ON / input-OFF track; ` +
              `remove the override so it wins.`
          : undefined,
      ).toBe(true);
    },
  );

  it("does not flag legitimate non-Switch green container backgrounds", () => {
    const monetization = readFileSync(
      resolve(
        cloudRoot,
        "applications/components/app-monetization-settings.tsx",
      ),
      "utf8",
    );
    // Container backgrounds exist and must remain untouched by this ratchet.
    expect(monetization).toContain("bg-green-500/10");
    expect(findForbidden(monetization)).toHaveLength(0);
  });

  it("detects a reintroduced green ON track override", () => {
    const regressed = `<Switch className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-neutral-700" />`;
    expect(findForbidden(regressed)).toEqual([
      "data-[state=checked]:bg-green-500",
      "data-[state=unchecked]:bg-neutral-700",
    ]);
  });

  it("detects a reintroduced switch-thumb selector override", () => {
    const regressed = `<Switch className="[&_[data-slot=switch-thumb]]:data-[state=checked]:bg-green-500" />`;
    expect(findForbidden(regressed)).toContain("data-slot=switch-thumb");
  });
});
