/**
 * Verifies the unified app's homepage asset manifest against real source files
 * and exercises its nested-directory copy boundary in an isolated directory.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOMEPAGE_PUBLIC_ASSETS,
  syncHomepageAssets,
} from "./sync-homepage-assets.mjs";

const homepagePublic = fileURLToPath(
  new URL("../../homepage/public/", import.meta.url),
);
const landingDemoSource = fileURLToPath(
  new URL("../../homepage/src/lib/landing-demo.ts", import.meta.url),
);
const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

test("every approved homepage asset exists in the source module", async () => {
  assert.equal(
    new Set(HOMEPAGE_PUBLIC_ASSETS).size,
    HOMEPAGE_PUBLIC_ASSETS.length,
    "homepage asset manifest must not contain duplicate paths",
  );

  await Promise.all(
    HOMEPAGE_PUBLIC_ASSETS.map(async (relativePath) => {
      const source = path.join(homepagePublic, relativePath);
      assert.equal(
        (await stat(source)).isFile(),
        true,
        `homepage asset manifest source is not a file: ${relativePath}`,
      );
    }),
  );
});

test("every avatar referenced by the shared landing demo is emitted", async () => {
  const source = await readFile(landingDemoSource, "utf8");
  const referencedAvatars = [
    ...source.matchAll(/"\/(brand\/people\/[^"']+\.webp)"/g),
  ].map((match) => match[1]);
  const emittedAvatars = HOMEPAGE_PUBLIC_ASSETS.filter((relativePath) =>
    relativePath.startsWith("brand/people/"),
  );

  assert.deepEqual(
    [...new Set(emittedAvatars)].sort(),
    [...new Set(referencedAvatars)].sort(),
    "homepage avatar manifest must match the shared landing demo",
  );
});

test("asset sync preserves bytes and nested relative paths", async () => {
  const destinationRoot = await mkdtemp(
    path.join(os.tmpdir(), "eliza-homepage-assets-"),
  );
  temporaryRoots.push(destinationRoot);

  await syncHomepageAssets({
    sourceRoot: homepagePublic,
    destinationRoot,
  });

  await Promise.all(
    HOMEPAGE_PUBLIC_ASSETS.map(async (relativePath) => {
      const [source, destination] = await Promise.all([
        readFile(path.join(homepagePublic, relativePath)),
        readFile(path.join(destinationRoot, relativePath)),
      ]);
      assert.deepEqual(destination, source, relativePath);
    }),
  );
});
