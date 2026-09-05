/**
 * Contract tests for the archive-overlay retirement (#16290): the checked-in
 * static asset manifest must match a pristine checkout (no implicit artifact
 * sync may be needed to make it green), and the overlay-only assets retired
 * with the eliza-archive sync must not resurface — neither as files nor as
 * references from production source. The manifest case materializes tracked
 * assets plus the real homepage generator in isolation so parallel builds
 * cannot expose a half-synchronized public tree.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { syncHomepageAssets } from "../../../app/scripts/sync-homepage-assets.mjs";
import {
  STATIC_ASSET_MANIFEST_REPO_PATH,
  validateStaticAssetManifest,
} from "../lib/static-asset-manifest.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * Assets that existed only in the retired eliza-archive overlay. They have no
 * source-owned producer, so no checkout may contain them and no production
 * code may reference them.
 */
const RETIRED_OVERLAY_PATHS = [
  "packages/app/public/app-heroes/database-viewer.png",
  "packages/app/public/app-heroes/log-viewer.png",
  "packages/app/public/app-heroes/memory-viewer.png",
  "packages/app/public/app-heroes/plugin-viewer.png",
  "packages/app/public/app-heroes/relationship-viewer.png",
  "packages/app/public/app-heroes/runtime-debugger.png",
  "packages/app/public/app-heroes/skills-viewer.png",
  "packages/app/public/app-heroes/trajectory-viewer.png",
  "packages/app/public/brand/background/Clouds_Loop_HQ_1080p.mp4",
  "packages/app/public/brand/background/Clouds_Loop_Mobile_480p.mp4",
  "packages/app/public/brand/concepts/billboard_concept.jpg",
  "packages/app/public/brand/concepts/chibi_usb_concept.jpg",
  "packages/app/public/brand/concepts/concept_minipc.jpg",
  "packages/app/public/brand/concepts/concept_phone.jpg",
  "packages/app/public/brand/concepts/concept_usbdrive.jpg",
  "packages/homepage/public/brand/background/Clouds_Loop_HQ_1080p.mp4",
  "packages/homepage/public/brand/background/Clouds_Loop_Mobile_480p.mp4",
  "packages/homepage/public/models/iphone-meshopt.glb",
  "packages/homepage/public/product/elizaos-usb-key-concept.png",
  "packages/app-core/platforms/ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png",
];

/**
 * Distinctive tokens for the retired assets. The sized concept renditions
 * (e.g. billboard_concept_1200.jpg) are source-owned and intentionally do NOT
 * match these unsized names.
 */
const RETIRED_REFERENCE_TOKENS = [
  "app-heroes/database-viewer.png",
  "app-heroes/log-viewer.png",
  "app-heroes/memory-viewer.png",
  "app-heroes/plugin-viewer.png",
  "app-heroes/relationship-viewer.png",
  "app-heroes/runtime-debugger.png",
  "app-heroes/skills-viewer.png",
  "app-heroes/trajectory-viewer.png",
  "Clouds_Loop_HQ_1080p.mp4",
  "Clouds_Loop_Mobile_480p.mp4",
  "concepts/billboard_concept.jpg",
  "concepts/chibi_usb_concept.jpg",
  "concepts/concept_minipc.jpg",
  "concepts/concept_phone.jpg",
  "concepts/concept_usbdrive.jpg",
  "iphone-meshopt.glb",
  "elizaos-usb-key-concept.png",
  "splash-2732x2732.png",
];

/**
 * Paths where a retired token may legitimately appear: test corpora exercise
 * URL handling with example strings, and .gitignore rules keep an opt-in
 * archive fetch from polluting git status — ignoring a file is not consuming
 * it.
 */
function isExemptFromReferenceScan(repoRelativePath: string): boolean {
  return (
    repoRelativePath.split("/").pop() === ".gitignore" ||
    repoRelativePath.includes("/__tests__/") ||
    repoRelativePath.includes("/test/") ||
    repoRelativePath.includes("/tests/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(repoRelativePath)
  );
}

async function materializePristineAssetRoot(): Promise<string> {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "eliza-static-asset-contract-"),
  );
  const trackedAssets = execFileSync(
    "git",
    [
      "-C",
      REPO_ROOT,
      "ls-files",
      "-z",
      "--",
      "packages/app/public",
      "packages/homepage/public",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const fixturePaths = [...trackedAssets, STATIC_ASSET_MANIFEST_REPO_PATH];
  await Promise.all(
    fixturePaths.map(async (relativePath) => {
      const destination = path.join(fixtureRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(REPO_ROOT, relativePath), destination);
    }),
  );
  await syncHomepageAssets({
    sourceRoot: path.join(fixtureRoot, "packages/homepage/public"),
    destinationRoot: path.join(fixtureRoot, "packages/app/public"),
  });
  return fixtureRoot;
}

describe("static asset manifest contract (#16290)", () => {
  it("checked-in manifest matches a pristine checkout with no overlay", async () => {
    const fixtureRoot = await materializePristineAssetRoot();
    try {
      const result = validateStaticAssetManifest(fixtureRoot);
      if (!result.ok) {
        const expected = JSON.parse(result.expected ?? "{}");
        const actual = JSON.parse(result.actual ?? "{}");
        const detail = ["app", "homepage"]
          .flatMap((tree) => {
            const onDisk = new Set<string>(expected[tree] ?? []);
            const inManifest = new Set<string>(actual[tree] ?? []);
            return [
              ...[...inManifest]
                .filter((entry) => !onDisk.has(entry))
                .map(
                  (entry) =>
                    `${tree}: manifest entry missing on disk: ${entry}`,
                ),
              ...[...onDisk]
                .filter((entry) => !inManifest.has(entry))
                .map(
                  (entry) => `${tree}: on disk but not in manifest: ${entry}`,
                ),
            ];
          })
          .join("\n");
        throw new Error(
          `static asset manifest is ${result.reason}; run node packages/app-core/scripts/generate-static-asset-manifest.mjs\n${detail}`,
        );
      }
      expect(result.ok).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("retired overlay assets do not exist in the checkout", () => {
    const present = RETIRED_OVERLAY_PATHS.filter((relativePath) =>
      existsSync(path.join(REPO_ROOT, relativePath)),
    );
    expect(present).toEqual([]);
  });

  it("production source does not reference retired overlay assets", () => {
    // git grep exits 1 on "no matches", which is the passing outcome here.
    let stdout = "";
    try {
      stdout = execFileSync(
        "git",
        [
          "-C",
          REPO_ROOT,
          "grep",
          "-n",
          "-F",
          ...RETIRED_REFERENCE_TOKENS.flatMap((token) => ["-e", token]),
          "--",
          ":(top)**",
          ":(exclude)**/__tests__/**",
          ":(exclude)**/test/**",
          ":(exclude)**/tests/**",
          ":(exclude)**/*.test.*",
          ":(exclude)**/*.spec.*",
        ],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      if (failure.status !== 1) {
        throw error;
      }
      stdout = failure.stdout ?? "";
    }
    const offenders = stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const [file] = line.split(":", 1);
        return !isExemptFromReferenceScan(file);
      });
    expect(offenders).toEqual([]);
  }, 30_000);
});
