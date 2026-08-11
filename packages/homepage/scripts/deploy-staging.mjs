#!/usr/bin/env node
/**
 * One-command staging deploy for the homepage: build (staging mode) -> deploy
 * to the eliza-home-staging Cloudflare Pages project -> verify that
 * https://staging.eliza.app actually serves the new bundle.
 *
 * Exists because the manual flow has two silent failure modes that both bit us
 * on 2026-08-11:
 *
 *   1. Hand-exported VITE_ vars: forget one and Vite silently inlines the prod
 *      default. Fixed by `--mode staging` + the committed .env.staging file
 *      (single source of truth; CI must use the same invocation).
 *   2. `wrangler pages deploy` without `--branch develop`: the project's
 *      production branch is `develop`, so a branchless deploy from any other
 *      local branch lands in a PREVIEW slot — wrangler prints a green success
 *      URL and the real domain keeps serving the old bundle. Fixed by always
 *      passing --branch develop and then polling the domain for the freshly
 *      built entry assets, failing loudly if they never show up.
 *
 * Usage: bun run deploy:staging          (from packages/homepage)
 *        node scripts/deploy-staging.mjs [--skip-build] [--allow-dirty]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "eliza-home-staging";
const BRANCH = "develop"; // = the project's production branch. NEVER omit.
const STAGING_URL = "https://staging.eliza.app/";
const WRANGLER_VERSION = "4.116.0"; // keep aligned with deploy:preview/production
const VERIFY_ATTEMPTS = 20;
const VERIFY_INTERVAL_MS = 6000;

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));

function fail(msg) {
  console.error(`\n[deploy:staging] FAIL: ${msg}`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  console.log(`[deploy:staging] $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: pkgRoot, ...opts });
}

// --- Preflight -------------------------------------------------------------

if (!existsSync(path.join(pkgRoot, ".env.staging"))) {
  fail(".env.staging missing — it is the canonical staging build config and is committed to the repo.");
}

const dirty = execSync("git status --porcelain -- .", { cwd: pkgRoot }).toString().trim();
if (dirty && !args.has("--allow-dirty")) {
  console.error(dirty);
  fail("homepage worktree is dirty. Staging should serve committed code. Commit first, or pass --allow-dirty if you are intentionally smoke-testing WIP.");
}

// Shell-inherited VITE_ vars outrank .env.staging in Vite's precedence order —
// exactly the hand-exported-env failure this script exists to kill. Scrub them.
const buildEnv = { ...process.env };
for (const key of Object.keys(buildEnv)) {
  if (key.startsWith("VITE_")) {
    console.warn(`[deploy:staging] scrubbing inherited ${key} (would override .env.staging)`);
    delete buildEnv[key];
  }
}
// Stamp asset filenames with the real commit (vite.config.ts reads GITHUB_SHA).
buildEnv.GITHUB_SHA = execSync("git rev-parse HEAD", { cwd: pkgRoot }).toString().trim();

// --- Build -----------------------------------------------------------------

if (!args.has("--skip-build")) {
  // `bun run build` triggers pre/postbuild (channel-config guard, asset sync,
  // release data, asset pruning); extra args flow through to `vite build`.
  run("bun run build --mode staging", { env: buildEnv });
}

// --- Sanity: bundle must point at staging, never prod ---------------------

const distDir = path.join(pkgRoot, "dist");
const indexHtml = path.join(distDir, "index.html");
if (!existsSync(indexHtml)) fail("dist/index.html missing — build did not run?");

const grepProd = execSync(
  `grep -rl "https://www.elizacloud.ai" assets/ 2>/dev/null || true`,
  { cwd: distDir },
).toString().trim();
if (grepProd) {
  console.error(grepProd);
  fail("built bundle references the PROD API (www.elizacloud.ai). --mode staging did not take effect; refusing to deploy to staging.");
}
const grepStaging = execSync(
  `grep -rl "https://staging.elizacloud.ai" assets/ 2>/dev/null || true`,
  { cwd: distDir },
).toString().trim();
if (!grepStaging) {
  fail("built bundle has no staging.elizacloud.ai reference — unexpected; refusing to deploy.");
}

// Entry assets referenced by index.html: these filenames are content+commit
// hashed, so "the domain serves them" == "the domain serves this build".
const html = readFileSync(indexHtml, "utf8");
const localAssets = [...html.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]);
if (localAssets.length === 0) fail("no hashed assets found in dist/index.html");
console.log(`[deploy:staging] build fingerprint: ${localAssets.join(", ")}`);

// --- Deploy ----------------------------------------------------------------

run(
  `bunx wrangler@${WRANGLER_VERSION} pages deploy dist --project-name ${PROJECT} --branch ${BRANCH} --commit-hash ${buildEnv.GITHUB_SHA} --commit-dirty=${dirty ? "true" : "false"}`,
);

// --- Verify the DOMAIN (not the per-deploy preview URL) --------------------

console.log(`[deploy:staging] verifying ${STAGING_URL} serves this build...`);
let served = "";
for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt++) {
  try {
    const res = await fetch(STAGING_URL, {
      headers: { "cache-control": "no-cache" },
      redirect: "follow",
    });
    served = await res.text();
    if (res.ok && localAssets.every((a) => served.includes(a))) {
      console.log(`[deploy:staging] OK — ${STAGING_URL} serves the new bundle (attempt ${attempt}).`);
      process.exit(0);
    }
  } catch (err) {
    console.warn(`[deploy:staging] fetch failed (attempt ${attempt}): ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
}

const servedAssets = [...served.matchAll(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g)].map((m) => m[0]);
console.error(`[deploy:staging] expected: ${localAssets.join(", ")}`);
console.error(`[deploy:staging] domain serves: ${servedAssets.join(", ") || "(no assets / fetch failed)"}`);
fail(
  `${STAGING_URL} did not pick up the new bundle after ${(VERIFY_ATTEMPTS * VERIFY_INTERVAL_MS) / 1000}s. ` +
    `Most likely the deploy landed in a preview slot (wrong --branch) or the project's production branch changed. ` +
    `Check: bunx wrangler@${WRANGLER_VERSION} pages deployment list --project-name ${PROJECT}`,
);
