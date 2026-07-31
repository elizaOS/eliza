/**
 * Filesystem-level contract tests for fail-closed homepage asset pruning.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneUnusedStaticAssets } from "../scripts/prune-unused-static-assets.mjs";

function createDist() {
  const root = mkdtempSync(join(tmpdir(), "homepage-prune-"));
  mkdirSync(join(root, "brand/background"), { recursive: true });
  mkdirSync(join(root, "product"), { recursive: true });
  writeFileSync(join(root, "brand/background/clouds.jpg"), "asset");
  writeFileSync(join(root, "product/concept.png"), "asset");
  return root;
}

test("pruning aborts before deletion when built output references a candidate", () => {
  const root = createDist();
  try {
    writeFileSync(
      join(root, "index.html"),
      '<img src="/brand/background/clouds.jpg">',
    );

    assert.throws(
      () => pruneUnusedStaticAssets(root),
      /Refusing to prune referenced homepage assets/,
    );
    assert.equal(existsSync(join(root, "brand/background/clouds.jpg")), true);
    assert.equal(existsSync(join(root, "product/concept.png")), true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("pruning removes only unreferenced candidate directories", () => {
  const root = createDist();
  try {
    writeFileSync(join(root, "index.html"), '<img src="/eliza-logo.webp">');

    pruneUnusedStaticAssets(root);

    assert.equal(existsSync(join(root, "brand/background")), false);
    assert.equal(existsSync(join(root, "product")), false);
    assert.equal(existsSync(join(root, "index.html")), true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("pruning refuses a missing build directory", () => {
  const missing = join(tmpdir(), `homepage-missing-${Date.now()}`);
  assert.throws(
    () => pruneUnusedStaticAssets(missing),
    /Homepage dist directory does not exist/,
  );
});
