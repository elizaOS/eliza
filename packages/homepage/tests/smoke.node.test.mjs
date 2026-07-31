/**
 * Source-level smoke test for the marketing page export without importing the React tree.
 *
 * The package test script runs under node:test, so this avoids pulling three.js
 * or adding Vitest just to confirm the entry component remains exportable.
 */

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const marketingPath = resolve(__dirname, "../src/pages/marketing.tsx");
const globalStylesPath = resolve(__dirname, "../src/index.css");
const iphoneModelPath = resolve(
  __dirname,
  "../public/models/iphone-meshopt.glb",
);
const elizaAvatarPath = resolve(__dirname, "../public/elizapfp.webp");
const profileImagePath = resolve(
  __dirname,
  "../public/eliza-app-profile-image.webp",
);
const headersPath = resolve(__dirname, "../public/_headers");
const viteConfigPath = resolve(__dirname, "../vite.config.ts");
const tsconfigPath = resolve(__dirname, "../tsconfig.app.json");

test("marketing.tsx exports a default function component", () => {
  const src = readFileSync(marketingPath, "utf8");
  assert.match(
    src,
    /export\s+default\s+function\s+\w+/,
    "expected `export default function ...` in marketing.tsx",
  );
});

test("landing ships compressed iPhone and WebP profile assets", () => {
  const model = readFileSync(iphoneModelPath);
  assert.equal(model.subarray(0, 4).toString("ascii"), "glTF");
  assert.ok(
    statSync(iphoneModelPath).size < 750_000,
    "phone model must stay under its 750 KB transfer budget",
  );

  for (const assetPath of [elizaAvatarPath, profileImagePath]) {
    const asset = readFileSync(assetPath);
    assert.equal(asset.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(asset.subarray(8, 12).toString("ascii"), "WEBP");
  }
  assert.ok(
    statSync(elizaAvatarPath).size < 8_000,
    "phone avatar must stay under its 8 KB transfer budget",
  );
  assert.ok(
    statSync(profileImagePath).size < 25_000,
    "profile image must stay under its 25 KB transfer budget",
  );
});

test("large visual assets receive a durable browser cache policy", () => {
  const headers = readFileSync(headersPath, "utf8");

  for (const route of ["/models/*", "/*.webp", "/*.woff2"]) {
    assert.match(
      headers,
      new RegExp(
        `${route.replaceAll("*", "\\*")}\\n\\s+Cache-Control: public, max-age=604800, stale-while-revalidate=86400`,
      ),
    );
  }
});

test("reduced-motion keeps functional loading indicators animated", () => {
  const css = readFileSync(globalStylesPath, "utf8");
  const reducedMotionStart = css.indexOf(
    "@media (prefers-reduced-motion: reduce)",
  );

  assert.notEqual(
    reducedMotionStart,
    -1,
    "expected a reduced-motion override block",
  );
  const reducedMotionBlock = css.slice(reducedMotionStart);
  assert.match(reducedMotionBlock, /\.animate-spin/);
  assert.match(reducedMotionBlock, /\[class~="animate-spin"\]/);
  assert.match(reducedMotionBlock, /\[role="progressbar"\]/);
  assert.match(reducedMotionBlock, /animation-duration:\s*1s\s*!important/);
  assert.match(
    reducedMotionBlock,
    /animation-iteration-count:\s*infinite\s*!important/,
  );
});

test("clean builds resolve bare shared imports to language-only source", () => {
  const viteConfig = readFileSync(viteConfigPath, "utf8");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));

  assert.match(viteConfig, /find:\s*"@elizaos\/shared"/);
  assert.match(viteConfig, /\.\.\/shared\/src\/i18n\/language\.ts/);
  assert.deepEqual(tsconfig.compilerOptions.paths["@elizaos/shared"], [
    "../shared/src/i18n/language.ts",
  ]);
});
