/**
 * Real-browser visual e2e for the frontend-hosting dashboard tab
 * (#10690 UI trigger + #10725 visual audit).
 *
 * Boots the REAL mock cloud stack (cloud-api Hono graph + PGlite + MOCK_REDIS
 * + in-memory R2), mints a real `eliza_*` key via headless SIWE, creates a
 * real app, compiles the REAL Tailwind v4 stylesheet (base.css +
 * tailwind-theme.css over the actual component sources), bundles the fixture
 * with esbuild, serves it from a same-origin page that proxies `/api/*` to
 * the live cloud API, and drives the whole publish → activate → rollback →
 * delete lifecycle in headless Chromium.
 *
 * Asserts behaviour AND the #10725 aesthetic rules (accent button is orange,
 * no blue anywhere on the page), and captures desktop + mobile screenshots at
 * rest/hover/dialog states plus the cloud-inactive (API unreachable) state,
 * with a video walkthrough.
 *
 * Run: bun src/cloud/applications/__e2e__/run-frontend-hosting-e2e.mjs
 * Output: src/cloud/applications/__e2e__/output-frontend-hosting/
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPostcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, "../../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-frontend-hosting");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Leg-3 port range (363xx).
const API_PORT = 36313;
const PAGE_PORT = 36314;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DEAD_API_BASE = "http://127.0.0.1:36399"; // nothing listens here

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// 1. Real mock cloud stack
// ---------------------------------------------------------------------------

const pgdata = mkdtempSync(join(tmpdir(), "w3-hosting-visual-pg-"));
const stackEnv = {
  ...process.env,
  MOCK_REDIS: "1",
  DATABASE_URL: `pglite://${pgdata}`,
  API_DEV_PORT: String(API_PORT),
  CRON_SECRET: "local-cron-secret",
  ELIZA_KMS_BACKEND: "local",
  ELIZA_LOCAL_ROOT_KEY: Buffer.alloc(32, 7).toString("base64"),
};

console.log("== migrate PGlite ==");
await new Promise((res, rej) => {
  const p = spawn("bun", ["run", "--cwd", "packages/cloud/shared", "db:migrate"], {
    cwd: repoRoot,
    env: stackEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`migrate exit ${c}`))));
});

console.log("== boot cloud-api ==");
const apiServer = spawn(
  "bun",
  ["run", "packages/scripts/cloud/admin/dev/cloud-api-hono-dev.ts"],
  { cwd: repoRoot, env: stackEnv, stdio: ["ignore", "ignore", "inherit"] },
);
process.on("exit", () => {
  try {
    apiServer.kill("SIGTERM");
  } catch {}
});
{
  let healthy = false;
  for (let i = 0; i < 240 && !healthy; i += 1) {
    try {
      healthy = (await fetch(`${API_BASE}/api/health`)).ok;
    } catch {}
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) throw new Error("cloud-api never became healthy");
}

const j = async (m, p, b, key) => {
  const r = await fetch(`${API_BASE}${p}`, {
    method: m,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => null) };
};

console.log("== SIWE signup ==");
const n = await j("GET", "/api/auth/siwe/nonce?chainId=1");
const acct = privateKeyToAccount(generatePrivateKey());
const msg = createSiweMessage({
  address: acct.address,
  chainId: n.d.chainId || 1,
  domain: n.d.domain,
  nonce: n.d.nonce,
  uri: n.d.uri,
  version: n.d.version || "1",
  statement: n.d.statement,
});
const verify = await j("POST", "/api/auth/siwe/verify", {
  message: msg,
  signature: await acct.signMessage({ message: msg }),
});
const KEY = verify.d?.apiKey;
if (!KEY) throw new Error(`SIWE verify failed: ${verify.s}`);

const app = await j(
  "POST",
  "/api/v1/apps",
  { name: "w3-hosting-e2e", app_url: "https://example.com", skipGitHubRepo: true },
  KEY,
);
const APP_ID = app.d?.app?.id;
if (!APP_ID) throw new Error(`app create failed: ${app.s}`);
console.log("app", APP_ID);

// ---------------------------------------------------------------------------
// 2. Real CSS (Tailwind v4 over the actual sources) + fixture bundle
// ---------------------------------------------------------------------------

console.log("== compile Tailwind CSS ==");
const cssEntry = `
@import "tailwindcss" source(none);
@source "./cloud/applications";
@source "./components/ui";
@import "./styles/base.css";
@import "./styles/tailwind-theme.css";
`;
const cssResult = await postcss([tailwindPostcss()]).process(cssEntry, {
  from: join(uiSrc, "__w3-hosting-e2e-entry__.css"),
});
const css = cssResult.css;

console.log("== bundle fixture ==");
// packages/ui/tsconfig.json aliases @elizaos/* → workspace src (the Node
// graph). Hand esbuild a bare tsconfig so package `exports` "browser"
// conditions resolve instead (e.g. @elizaos/core → dist/browser).
const bareTsconfig = join(outDir, "esbuild-tsconfig.json");
await writeFile(bareTsconfig, JSON.stringify({ compilerOptions: {} }));
const bundle = await build({
  entryPoints: [join(here, "frontend-hosting-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  tsconfig: bareTsconfig,
  // @elizaos/core's browser dist keeps Node deps behind lazy requires that
  // never execute in the browser; leave them as unbundled externals.
  external: [
    "node:*",
    "fs",
    "path",
    "stream",
    "constants",
    "os",
    "crypto",
    "util",
    "assert",
    "events",
    "url",
    "buffer",
    "child_process",
    "tty",
    "fs-extra",
    "graceful-fs",
    "jsonfile",
  ],
  write: false,
});
const js = bundle.outputFiles[0].text;

const pageHtml = (apiBase) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>frontend hosting e2e</title>
<style>${css}</style>
</head><body><div id="root"></div>
<script>
  window.__W3_APP_ID__ = ${JSON.stringify(APP_ID)};
  window.__W3_API_BASE__ = ${JSON.stringify(apiBase)};
  localStorage.setItem("steward_session_token", ${JSON.stringify(KEY)});
</script>
<script>${js.replace(/<\/script>/g, "<\\/script>")}</script></body></html>`;

// Same-origin page host that proxies /api/* to the live cloud API — the same
// shape as production, where the dashboard's relative /api calls land on the
// cloud API behind the page origin.
let proxyTarget = API_BASE;
const pageServer = Bun.serve({
  hostname: "127.0.0.1",
  port: PAGE_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await fetch(`${proxyTarget}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : await request.arrayBuffer(),
        });
      } catch {
        return new Response("upstream unreachable", { status: 502 });
      }
    }
    return new Response(pageHtml(proxyTarget), {
      headers: { "content-type": "text/html" },
    });
  },
});
process.on("exit", () => {
  try {
    pageServer.stop(true);
  } catch {}
});

// ---------------------------------------------------------------------------
// 3. Drive it in Chromium
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text());
});

let shot = 0;
async function snap(name, target = page) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await target.screenshot({ path: join(outDir, file), fullPage: true });
  console.log(`  📸 ${file}`);
}

const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
await page.goto(PAGE_URL);

// --- empty state -----------------------------------------------------------
await page.getByText("No deployments yet").waitFor({ timeout: 30_000 });
await snap("desktop-empty");

// #10725 aesthetic gates, asserted on real computed styles.
const colorInfo = await page.evaluate(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const offenders = [];
  for (const el of document.querySelectorAll("*")) {
    const st = getComputedStyle(el);
    for (const prop of ["color", "backgroundColor", "borderTopColor"]) {
      const rgb = parse(st[prop]);
      // "Blue" = blue channel clearly dominates both red and green.
      if (rgb && rgb[2] > rgb[0] + 40 && rgb[2] > rgb[1] + 40) {
        offenders.push(`${el.tagName}.${el.className} ${prop}=${st[prop]}`);
      }
    }
  }
  return { offenders: offenders.slice(0, 5), count: offenders.length };
});
assert(
  colorInfo.count === 0,
  `no blue anywhere on the page (offenders: ${colorInfo.count})`,
);
if (colorInfo.count > 0) console.log(colorInfo.offenders);

// --- publish v1 through the real picker -------------------------------------
await page.setInputFiles('[data-testid="hosting-files-input"]', {
  name: "index.html",
  mimeType: "text/html",
  buffer: Buffer.from("<html><body><h1>w3 visual v1</h1></body></html>"),
});
await page.getByTestId("hosting-selection-summary").waitFor();
const publishBtn = page.getByTestId("hosting-publish");
const publishRgb = await publishBtn.evaluate((el) => {
  const m = getComputedStyle(el).backgroundColor.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)/,
  );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
});
assert(
  publishRgb && publishRgb[0] > publishRgb[2] && publishRgb[1] > publishRgb[2],
  `primary Publish button is orange-accent, not blue/black (${publishRgb})`,
);
await publishBtn.hover();
// The button animates via transition-colors — let it settle before reading.
await page.waitForTimeout(400);
const publishHoverRgb = await publishBtn.evaluate((el) => {
  const m = getComputedStyle(el).backgroundColor.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+)/,
  );
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
});
assert(
  publishHoverRgb &&
    String(publishHoverRgb) !== String(publishRgb) &&
    publishHoverRgb[0] > 60 &&
    publishHoverRgb[0] > publishHoverRgb[2],
  `hover is a DARKER orange — changed from rest, never orange→black/blue (rest ${publishRgb} → hover ${publishHoverRgb})`,
);
await snap("desktop-selection-hover-publish");

await publishBtn.click();
await page.getByTestId("hosting-deployment-1").waitFor({ timeout: 30_000 });
assert(
  (await page.getByText("live").count()) === 1,
  "v1 row shows the live badge after publish",
);
await snap("desktop-v1-live");

// --- publish v2, then roll back to v1 ---------------------------------------
await page.setInputFiles('[data-testid="hosting-files-input"]', {
  name: "index.html",
  mimeType: "text/html",
  buffer: Buffer.from("<html><body><h1>w3 visual v2</h1></body></html>"),
});
await page.getByTestId("hosting-selection-summary").waitFor();
await page.getByTestId("hosting-publish").click();
await page.getByTestId("hosting-deployment-2").waitFor({ timeout: 30_000 });
await snap("desktop-v2-live");

const rollbackBtn = page.getByTestId("hosting-activate-1");
assert(
  (await rollbackBtn.textContent())?.includes("Roll back"),
  "older version's action is labeled Roll back",
);
await rollbackBtn.click();
await page.getByTestId("hosting-activate-confirm").waitFor();
await snap("desktop-rollback-confirm-dialog");
await page.getByTestId("hosting-activate-confirm").click();
await page.waitForFunction(
  () =>
    document
      .querySelector('[data-testid="hosting-deployment-1"]')
      ?.textContent?.includes("live") ?? false,
  { timeout: 30_000 },
);
await snap("desktop-rolled-back-to-v1");

// Server truth: preview must serve v1 bytes again.
const previewRes = await fetch(`${API_BASE}/api/v1/apps/${APP_ID}/frontend/preview/`, {
  headers: { authorization: `Bearer ${KEY}` },
});
const previewHtml = await previewRes.text();
assert(
  previewRes.status === 200 && previewHtml.includes("w3 visual v1"),
  "owner preview serves the rolled-back v1 bytes",
);

// --- delete v2 ---------------------------------------------------------------
await page.getByTestId("hosting-delete-2").click();
await page.getByTestId("hosting-delete-confirm").waitFor();
await snap("desktop-delete-confirm-dialog");
await page.getByTestId("hosting-delete-confirm").click();
await page.waitForFunction(
  () => !document.querySelector('[data-testid="hosting-deployment-2"]'),
  { timeout: 30_000 },
);
await snap("desktop-after-delete-v2");

// --- mobile, cloud-active ----------------------------------------------------
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(PAGE_URL);
await mobile.getByTestId("hosting-deployment-1").waitFor({ timeout: 30_000 });
await snap("mobile-v1-live", mobile);
await mobile.setInputFiles('[data-testid="hosting-files-input"]', {
  name: "index.html",
  mimeType: "text/html",
  buffer: Buffer.from("<html><body>m</body></html>"),
});
await mobile.getByTestId("hosting-selection-summary").waitFor();
await snap("mobile-selection", mobile);
await mobile.close();

// --- cloud-inactive (API unreachable) ----------------------------------------
proxyTarget = DEAD_API_BASE;
await page.goto(PAGE_URL);
await page.getByRole("button", { name: "Retry" }).waitFor({ timeout: 30_000 });
await snap("desktop-cloud-inactive-error");
const inactiveMobile = await context.newPage();
await inactiveMobile.setViewportSize({ width: 390, height: 844 });
await inactiveMobile.goto(PAGE_URL);
await inactiveMobile
  .getByRole("button", { name: "Retry" })
  .waitFor({ timeout: 30_000 });
await snap("mobile-cloud-inactive-error", inactiveMobile);
await inactiveMobile.close();

// Retry recovers once the cloud is reachable again.
proxyTarget = API_BASE;
await page.getByRole("button", { name: "Retry" }).click();
await page.getByTestId("hosting-deployment-1").waitFor({ timeout: 30_000 });
await snap("desktop-recovered-after-retry");
assert(true, "Retry recovers from cloud-inactive once the API is back");

// ---------------------------------------------------------------------------
// 4. Wrap up
// ---------------------------------------------------------------------------

await context.close(); // flushes the video
await browser.close();
const { readdir, rename } = await import("node:fs/promises");
for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm")) {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
  }
}
await writeFile(
  join(outDir, "RESULT.json"),
  JSON.stringify({ failures, appId: APP_ID, when: new Date().toISOString() }, null, 2),
);

apiServer.kill("SIGTERM");
pageServer.stop(true);
await rm(pgdata, { recursive: true, force: true });

if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("ALL GREEN");
process.exit(0);
