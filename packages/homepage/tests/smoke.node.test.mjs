/**
 * Homepage asset, caching, API-origin, and build-configuration contracts exercised without importing the React tree.
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
const packageJsonPath = resolve(__dirname, "../package.json");
const appPackageJsonPath = resolve(__dirname, "../../app/package.json");
const appViteConfigPath = resolve(__dirname, "../../app/vite.config.ts");
const appAssetSyncPath = resolve(
  __dirname,
  "../../app/scripts/sync-homepage-assets.mjs",
);
const indexHtmlPath = resolve(__dirname, "../index.html");
const landingPath = resolve(__dirname, "../src/pages/landing.tsx");
const visualRegressionSpecPath = resolve(__dirname, "./e2e/visual.spec.ts");
const cloudApiClientPath = resolve(__dirname, "../src/lib/api/client.ts");
const playwrightLauncherPath = resolve(
  __dirname,
  "../scripts/run-playwright-web-server.mjs",
);
const cloudRouteMockPaths = [
  "./e2e/aesthetic-audit.spec.ts",
  "./e2e/app-routes-flow.spec.ts",
  "./e2e/contact-sheet-capture.spec.ts",
  "./e2e/telegram-return.spec.ts",
  "./e2e/visual.spec.ts",
].map((relativePath) => resolve(__dirname, relativePath));
const globalStylesPath = resolve(__dirname, "../src/index.css");
const elizaAvatarPath = resolve(
  __dirname,
  "../public/brand/logos/logo_white_orangebg.svg",
);
const profileImagePath = resolve(
  __dirname,
  "../public/eliza-app-profile-image.webp",
);
const headersPath = resolve(__dirname, "../public/_headers");
const viteConfigPath = resolve(__dirname, "../vite.config.ts");
const tsconfigPath = resolve(__dirname, "../tsconfig.app.json");

test("landing ships its canonical profile assets", () => {
  const avatar = readFileSync(elizaAvatarPath, "utf8");
  assert.match(avatar, /fill="#FF5800"/);
  const profileImage = readFileSync(profileImagePath);
  assert.equal(profileImage.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(profileImage.subarray(8, 12).toString("ascii"), "WEBP");
  assert.ok(
    statSync(elizaAvatarPath).size < 25_000,
    "canonical phone avatar must stay under its 25 KB transfer budget",
  );
  assert.ok(
    statSync(profileImagePath).size < 25_000,
    "profile image must stay under its 25 KB transfer budget",
  );
});

test("landing stays a static surface with no animation-framework dependencies", () => {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const appPackageJson = JSON.parse(readFileSync(appPackageJsonPath, "utf8"));
  const appViteConfig = readFileSync(appViteConfigPath, "utf8");
  const appAssetSync = readFileSync(appAssetSyncPath, "utf8");
  const landing = readFileSync(landingPath, "utf8");

  for (const dependency of [
    "@react-three/drei",
    "@react-spring/web",
    "@react-spring/three",
    "@use-gesture/react",
    "country-flag-icons",
  ]) {
    assert.equal(packageJson.dependencies[dependency], undefined);
  }
  assert.doesNotMatch(
    landing,
    /@react-three|react-spring|use-gesture|ModelViewers/,
  );
  assert.match(
    landing,
    /const ShaderBackground = lazy\(/,
    "the shader background must stay behind a lazy boundary",
  );
  for (const script of ["dev", "build", "preview", "deploy:production"]) {
    assert.equal(packageJson.scripts[script], undefined);
  }
  assert.match(appPackageJson.scripts.prebuild, /sync-homepage-assets/);
  assert.match(
    appPackageJson.scripts.typecheck,
    /write-homepage-release-data\.mjs\s+&&\s+tsc/,
  );
  assert.match(appViteConfig, /find:\s*\/\^@homepage\\\//);
  assert.match(appAssetSync, /\.\.\/homepage\/public/);
});

test("visual regression compares the quality-validated capture itself", () => {
  const visualSpec = readFileSync(visualRegressionSpecPath, "utf8");

  assert.match(
    visualSpec,
    /const screenshot = await captureScreenshotWithQualityRetry\(/,
  );
  assert.match(visualSpec, /expect\(screenshot\)\.toMatchSnapshot\(/);
});

test("cloud API defaults, the e2e server, and route mocks use the apex origin", () => {
  const apexOrigin = "https://api.eliza.app";
  const redirectedOrigin = "https://elizacloud.ai";
  const client = readFileSync(cloudApiClientPath, "utf8");
  const launcher = readFileSync(playwrightLauncherPath, "utf8");

  assert.ok(client.includes(`ELIZACLOUD_DEFAULT_URL = "${apexOrigin}"`));
  assert.ok(launcher.includes(`VITE_ELIZACLOUD_API_URL: "${apexOrigin}"`));
  assert.ok(!client.includes(`ELIZACLOUD_DEFAULT_URL = "${redirectedOrigin}"`));
  assert.ok(
    !launcher.includes(`VITE_ELIZACLOUD_API_URL: "${redirectedOrigin}"`),
  );

  for (const routeMockPath of cloudRouteMockPaths) {
    const routeMock = readFileSync(routeMockPath, "utf8");
    assert.ok(routeMock.includes(`${apexOrigin}/api/eliza-app/`));
    assert.ok(!routeMock.includes(`route("${redirectedOrigin}/api/eliza-app/`));
  }
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

test("preloaded image declares the MIME type of the referenced asset", () => {
  const indexHtml = readFileSync(indexHtmlPath, "utf8");
  const preloadTag = indexHtml.match(/<link(?=[^>]*rel="preload")[^>]*>/)?.[0];

  assert.ok(preloadTag, "expected an image preload tag");
  assert.match(preloadTag, /href="\/eliza-logo\.webp"/);
  assert.match(preloadTag, /type="image\/webp"/);
  assert.doesNotMatch(preloadTag, /favicon\.svg/);
});

test("built asset URLs include a deployment-specific cache revision", () => {
  const viteConfig = readFileSync(viteConfigPath, "utf8");

  assert.match(viteConfig, /process\.env\.GITHUB_SHA/);
  assert.match(viteConfig, /process\.env\.CF_PAGES_COMMIT_SHA/);
  assert.match(
    viteConfig,
    /entryFileNames: `assets\/\[name\]-\[hash\]-\$\{homepageBuildRevision\}\.js`/,
  );
  assert.match(
    viteConfig,
    /chunkFileNames: `assets\/\[name\]-\[hash\]-\$\{homepageBuildRevision\}\.js`/,
  );
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
