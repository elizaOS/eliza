/**
 * Homepage asset, caching, API-origin, and build-configuration contracts exercised without importing the React tree.
 *
 * The package test script runs under node:test, so this avoids pulling three.js
 * or adding Vitest just to confirm the entry component remains exportable.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  assert.match(
    landing,
    /function DeferredShaderBackground\(\)/,
    "the shader must not compete with the first useful hero paint",
  );
  assert.match(
    landing,
    /requestAnimationFrame\(\(\) => setReady\(true\)\)/,
    "the shader import must begin only after the static hero has painted",
  );
  for (const script of ["dev", "build", "preview", "deploy:production"]) {
    assert.equal(packageJson.scripts[script], undefined);
  }
  assert.match(appPackageJson.scripts.prebuild, /sync-homepage-assets/);
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

test("every response carries the defense-in-depth security header suite", () => {
  const headers = readFileSync(headersPath, "utf8");
  const globalBlock = headers.match(/^\/\*\n((?:[ \t]+\S.*\n)+)/m)?.[1] ?? "";
  const headerLine = (name) => {
    const line = globalBlock
      .split("\n")
      .find((candidate) => candidate.trimStart().startsWith(`${name}:`));
    assert.ok(line, `missing ${name} in the /* block`);
    return line.trimStart();
  };

  const csp = headerLine("Content-Security-Policy");
  assert.ok(
    csp.length < 1900,
    `CSP must stay under the Cloudflare Pages header limit (${csp.length} bytes)`,
  );
  // Clickjacking defense for the onboarding/auth pages.
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(headerLine("X-Frame-Options"), /^X-Frame-Options: SAMEORIGIN$/);
  // The CSP must reflect what the homepage really loads: the /get-started
  // Telegram widget is the only external script and renders its
  // oauth.telegram.org iframe; the index.html <body> carries an inline style;
  // sign-in providers are top-level navigations, not fetches.
  assert.match(
    csp,
    /script-src 'self' 'unsafe-eval' 'unsafe-inline' 'wasm-unsafe-eval' https:\/\/telegram\.org/,
  );
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /frame-src 'self' https:\/\/oauth\.telegram\.org/);
  assert.match(csp, /form-action 'self' https:\/\/oauth\.telegram\.org/);
  assert.match(
    csp,
    /connect-src 'self' https:\/\/eliza\.app https:\/\/\*\.eliza\.app wss:\/\/\*\.eliza\.app/,
  );
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);

  assert.match(
    headerLine("X-Content-Type-Options"),
    /^X-Content-Type-Options: nosniff$/,
  );
  assert.match(
    headerLine("Referrer-Policy"),
    /^Referrer-Policy: strict-origin-when-cross-origin$/,
  );
  assert.match(
    headerLine("Strict-Transport-Security"),
    /^Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/,
  );
  assert.match(
    headerLine("Permissions-Policy"),
    /^Permissions-Policy: camera=\(self\), microphone=\(self\), geolocation=\(self\)$/,
  );

  // A global Cache-Control would aggregate with the per-path rules below
  // (matching _headers rules join instead of overriding) and destroy the
  // durable asset caching enforced by the previous test.
  assert.doesNotMatch(globalBlock, /Cache-Control/);
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

// The deployable frontend is packages/app. A homepage `src="/…"` asset ships
// only if the app allowlists it (HOMEPAGE_PUBLIC_ASSETS in
// packages/app/scripts/sync-homepage-assets.mjs) or already owns a copy under
// packages/app/public. A reference that ships through neither 404s in the
// deployed app and is served the SPA index.html fallback: HTTP 200,
// text/html, so the image silently renders blank at naturalWidth 0 with zero
// build or CI errors. That class shipped /eliza-logotext.svg blank in
// production (2026-08-14); the per-instance fix bundled that one wordmark.
// This test is the standing guard for the whole class. Bundler imports
// (`import x from "@/assets/…"`) are exempt by construction: they ship with
// whatever build consumes the source.
const homepageSrcRoot = resolve(__dirname, "../src");
const appPublicRoot = resolve(__dirname, "../../app/public");

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("every url-referenced homepage public asset ships with the deployed app", async () => {
  const { HOMEPAGE_PUBLIC_ASSETS } = await import(
    pathToFileURL(appAssetSyncPath).href
  );
  const allowlisted = new Set(HOMEPAGE_PUBLIC_ASSETS);
  const assetUrl =
    /(?:src|href)=(?:"|')(\/[^"'?#]+\.(?:svg|png|webp|jpe?g|gif|ico|woff2?|ttf|otf))(?:"|')/g;

  const offenders = [];
  for (const file of collectSourceFiles(homepageSrcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(assetUrl)) {
      const rel = match[1].replace(/^\//, "");
      if (allowlisted.has(rel)) continue;
      if (existsSync(resolve(appPublicRoot, rel))) continue;
      offenders.push(`${file.slice(homepageSrcRoot.length + 1)} -> /${rel}`);
    }
  }

  assert.deepEqual(
    offenders.sort(),
    [],
    `homepage sources reference public assets the deployed app does not ship ` +
      `(they 404 into the SPA fallback and render blank with zero errors): ` +
      `${offenders.join(", ")}. Add each path to HOMEPAGE_PUBLIC_ASSETS in ` +
      `packages/app/scripts/sync-homepage-assets.mjs, place a copy under ` +
      `packages/app/public, or import it through the bundler ` +
      `(import x from "@/assets/…").`,
  );
});
