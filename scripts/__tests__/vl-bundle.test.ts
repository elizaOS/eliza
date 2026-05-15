/**
 * WS2 vision bundle invariants.
 *
 * Every catalog tier with `hasVision: true` must resolve to a mmproj
 * artifact in one of two ways:
 *
 *   1. The plan's `required_files` lists `vision/mmproj-<tier>.gguf`
 *      AND the BUNDLE_EXTRAS `vision.perTier[tier]` carries either a
 *      `staged: true` block (with a `stagedBuild` documenting the build
 *      step) OR is implicitly mirrored from upstream (no `staged`
 *      marker means the bundle pipeline downloads the file from a
 *      published HF mmproj GGUF at the catalog's bundle URL).
 *
 *   2. The plan does NOT list the mmproj AND the catalog claims
 *      `hasVision: false` for that tier (a coherent text-only bundle).
 *
 * This test fails when the surfaces drift apart — e.g. catalog claims
 * vision but the plan forgot the file, or the staged block goes missing
 * for a tier that does not have an upstream HF mmproj.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const PLAN_PATH = path.join(
  REPO_ROOT,
  "docs",
  "ELIZA_1_GGUF_PLATFORM_PLAN.json",
);
const EXTRAS_PATH = path.join(REPO_ROOT, "docs", "ELIZA_1_BUNDLE_EXTRAS.json");
const CATALOG_PATH = path.join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "local-inference",
  "catalog.ts",
);

interface PlanTier {
  required_files: string[];
}
interface VisionEntry {
  estimatedSizeBytes: number;
  quant?: string;
  staged?: boolean;
  stagedBuild?: {
    script?: string;
    step?: string;
    sourceModel?: string;
    rationale?: string;
    quant?: string;
    license?: string;
  };
}

function loadPlan(): Record<string, PlanTier> {
  return JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
}

function loadExtras(): {
  vision: { perTier: Record<string, VisionEntry> };
} {
  return JSON.parse(fs.readFileSync(EXTRAS_PATH, "utf8"));
}

function loadCatalogVisionFacts(): Map<string, boolean> {
  const src = fs.readFileSync(CATALOG_PATH, "utf8");
  const specsMatch = src.match(
    /TIER_SPECS:\s*Readonly<[\s\S]*?>\s*=\s*\{([\s\S]*?)\n\};/,
  );
  if (!specsMatch) {
    throw new Error("could not parse TIER_SPECS from catalog.ts");
  }
  const block = specsMatch[1];
  const tierBlocks = block.split(/"eliza-1-[^"]+":\s*\{/g);
  const tierHeaders = Array.from(
    block.matchAll(/"(eliza-1-[^"]+)":\s*\{/g),
    (m) => m[1],
  );
  const out = new Map<string, boolean>();
  for (let i = 0; i < tierHeaders.length; i += 1) {
    const tierId = tierHeaders[i];
    const body = tierBlocks[i + 1] ?? "";
    const cutoff = body.indexOf("\n  },");
    const tierBody = cutoff >= 0 ? body.slice(0, cutoff) : body;
    out.set(tierId, /hasVision:\s*true/.test(tierBody));
  }
  return out;
}

function planKeyToCatalogId(planKey: string): string {
  return `eliza-1-${planKey}`;
}

describe("WS2 vision bundle invariants", () => {
  const plan = loadPlan();
  const extras = loadExtras();
  const visionFacts = loadCatalogVisionFacts();
  const visionTiers = extras.vision.perTier;

  for (const planKey of Object.keys(plan)) {
    const catalogId = planKeyToCatalogId(planKey);
    it(`tier "${planKey}" resolves its mmproj path coherently`, () => {
      const catalogHasVision = visionFacts.get(catalogId) === true;
      const required = plan[planKey].required_files;
      const planClaimsMmproj = required.some(
        (f) => typeof f === "string" && f === `vision/mmproj-${planKey}.gguf`,
      );
      const planClaimsVisionLicense = required.includes(
        "licenses/LICENSE.vision",
      );

      if (catalogHasVision) {
        // hasVision tier MUST list a mmproj in required_files…
        expect(
          planClaimsMmproj,
          `catalog ${catalogId}.hasVision is true but plan ${planKey} is missing vision/mmproj-${planKey}.gguf in required_files`,
        ).toBe(true);
        // …AND the vision license.
        expect(
          planClaimsVisionLicense,
          `hasVision tier ${planKey} must include licenses/LICENSE.vision in required_files`,
        ).toBe(true);
        // …AND the extras vision block must carry a size estimate.
        const visionEntry = visionTiers[catalogId];
        expect(
          visionEntry,
          `extras.vision.perTier["${catalogId}"] missing — every hasVision tier needs a size estimate`,
        ).toBeDefined();
        expect(typeof visionEntry.estimatedSizeBytes).toBe("number");
        // …AND if marked staged, the stagedBuild block must be complete.
        if (visionEntry.staged === true) {
          expect(
            visionEntry.stagedBuild,
            `staged vision entry ${catalogId} needs a stagedBuild block`,
          ).toBeDefined();
          const sb = visionEntry.stagedBuild!;
          expect(typeof sb.script).toBe("string");
          expect(sb.script!.length).toBeGreaterThan(0);
          expect(typeof sb.step).toBe("string");
          expect(sb.step!.length).toBeGreaterThan(0);
          expect(typeof sb.sourceModel).toBe("string");
          expect(sb.sourceModel!.length).toBeGreaterThan(0);
          expect(typeof sb.rationale).toBe("string");
          expect(sb.rationale!.length).toBeGreaterThan(0);
        }
      } else {
        // Text-only tier must not list a vision mmproj.
        expect(
          planClaimsMmproj,
          `catalog ${catalogId}.hasVision is false but plan ${planKey} still lists vision/mmproj-${planKey}.gguf`,
        ).toBe(false);
      }
    });
  }

  it("every staged vision entry references a vision license path", () => {
    for (const [tierId, entry] of Object.entries(visionTiers)) {
      if (entry.staged !== true) continue;
      expect(
        entry.stagedBuild?.license,
        `staged tier ${tierId} should record its license path under stagedBuild.license`,
      ).toMatch(/licenses\/LICENSE\.vision/);
    }
  });

  it("no vision entry is both staged and lists a download url (ambiguity guard)", () => {
    for (const [tierId, entry] of Object.entries(visionTiers)) {
      const hasUrl =
        typeof (entry as { url?: unknown }).url === "string" &&
        (entry as { url: string }).url.startsWith("http");
      const staged = entry.staged === true;
      expect(
        staged && hasUrl,
        `vision entry ${tierId} is both staged:true and has a download url — pick one`,
      ).toBe(false);
    }
  });

  it("0_8b and 2b are explicitly staged (no upstream Qwen3-VL mmproj at those sizes)", () => {
    expect(visionTiers["eliza-1-0_8b"].staged).toBe(true);
    expect(visionTiers["eliza-1-2b"].staged).toBe(true);
    // The 4b+ tiers are mirrored, not staged.
    expect(visionTiers["eliza-1-4b"].staged ?? false).toBe(false);
    expect(visionTiers["eliza-1-9b"].staged ?? false).toBe(false);
    expect(visionTiers["eliza-1-27b"].staged ?? false).toBe(false);
  });
});
