/**
 * Real-browser visual e2e for the #11341 cloud-surface unification.
 *
 * Boots the REAL mock cloud stack (cloud-api Hono graph + PGlite + MOCK_REDIS),
 * mints a real `eliza_*` key via headless SIWE, compiles the REAL Tailwind v4
 * stylesheet over the actual component sources, bundles the fixture with
 * esbuild, serves it same-origin with an /api proxy, and drives headless
 * Chromium through:
 *
 *  1. every legacy `/dashboard/*` account-management deep link, asserting the
 *     CloudRouterShell compat redirect lands on `/settings#<section>` (query
 *     preserved before the hash) and that the app-side hash contract
 *     (`readSettingsHashSection`) resolves the registered section — including
 *     the legacy `#billing` / `#api-keys` aliases;
 *  2. each canonical Settings section (billing incl. the relocated
 *     `?canceled=true` banner, monetization tabs, security incl. the
 *     hash-anchor links, api-keys, account) rendering real data from the mock
 *     stack, at desktop + mobile.
 *
 * Run: bun packages/ui/src/cloud/__e2e__/run-slop-removal-e2e.mjs
 * Output: packages/ui/src/cloud/__e2e__/output-slop-removal/
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
const uiSrc = resolve(here, "../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-slop-removal");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const API_PORT = 36423;
const PAGE_PORT = 36424;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// 1. Real mock cloud stack
// ---------------------------------------------------------------------------

const pgdata = mkdtempSync(join(tmpdir(), "slop-removal-pg-"));
// Resolve @elizaos/* from source (no dist build needed in a fresh checkout) —
// same trick as packages/test/cloud-e2e/playwright.config.ts.
const bunSourceCondition = "--conditions=eliza-source";
const bunOptions = process.env.BUN_OPTIONS?.includes(bunSourceCondition)
  ? process.env.BUN_OPTIONS
  : `${process.env.BUN_OPTIONS ?? ""} ${bunSourceCondition}`.trim();
const stackEnv = {
  ...process.env,
  BUN_OPTIONS: bunOptions,
  MOCK_REDIS: "1",
  DATABASE_URL: `pglite://${pgdata}`,
  API_DEV_PORT: String(API_PORT),
  CRON_SECRET: "local-cron-secret",
  ELIZA_KMS_BACKEND: "local",
  ELIZA_LOCAL_ROOT_KEY: Buffer.alloc(32, 7).toString("base64"),
  // The walkthrough fires many reads from one key in seconds; the
  // hono-cloudflare limiter shares one bucket per key across routes.
  RATE_LIMIT_DISABLED: "true",
  NODE_ENV: "test",
};

console.log("== migrate PGlite ==");
await new Promise((res, rej) => {
  const p = spawn(
    "bun",
    ["run", "--cwd", "packages/cloud/shared", "db:migrate"],
    { cwd: repoRoot, env: stackEnv, stdio: ["ignore", "ignore", "inherit"] },
  );
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

// ---------------------------------------------------------------------------
// 2. Real CSS (Tailwind v4 over the actual sources) + fixture bundle
// ---------------------------------------------------------------------------

console.log("== compile Tailwind CSS ==");
const cssEntry = `
@import "tailwindcss" source(none);
@source "./cloud";
@source "./cloud-ui";
@source "./components/ui";
@import "./styles/base.css";
@import "./styles/tailwind-theme.css";
`;
const cssResult = await postcss([tailwindPostcss()]).process(cssEntry, {
  from: join(uiSrc, "__slop-removal-e2e-entry__.css"),
});
const css = cssResult.css;

console.log("== bundle fixture ==");
const bareTsconfig = join(outDir, "esbuild-tsconfig.json");
await writeFile(bareTsconfig, JSON.stringify({ compilerOptions: {} }));
// Same trick as the credentials harness: under iife, esbuild's __require shim
// throws at module-eval time for node builtins that never actually run in the
// browser — stub them all with inert modules.
const nodeStubPlugin = {
  name: "node-builtin-stub",
  setup(pluginBuild) {
    const filter =
      /^(node:.*|fs|fs\/promises|dns\/promises|http|https|path|stream|constants|os|crypto|util|assert|events|url|buffer|child_process|tty|module|fs-extra|graceful-fs|jsonfile|worker_threads|zlib|net|tls|dns|readline|v8|vm|perf_hooks|async_hooks|string_decoder|querystring|punycode|domain|dgram|cluster|repl|inspector|trace_events|wasi|diagnostics_channel)$/;
    pluginBuild.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: `function anyfn() { return anyfn; }
export default anyfn;
export const createRequire = () => anyfn;
export const homedir = anyfn;
export const tmpdir = anyfn;
export const platform = anyfn;
export const isAbsolute = anyfn;
export const join = anyfn;
export const resolve = anyfn;
export const dirname = anyfn;
export const basename = anyfn;
export const extname = anyfn;
export const sep = "/";
export const createHash = () => ({ update: () => ({ digest: () => "" }) });
export const randomBytes = anyfn;
export const createHmac = () => ({ update: () => ({ digest: () => "" }) });
export const timingSafeEqual = () => false;
export const createCipheriv = anyfn;
export const createDecipheriv = anyfn;
export const pbkdf2Sync = anyfn;
export const scryptSync = anyfn;
export const Buffer = {
  from: () => ({}),
  isBuffer: () => false,
  alloc: () => ({}),
  byteLength: () => 0,
};
export const promises = {};
export const existsSync = () => false;
export const readFileSync = anyfn;
export const writeFileSync = anyfn;
export const mkdirSync = anyfn;
export const readdirSync = () => [];
export const statSync = anyfn;
export const EventEmitter = class {};
export const fileURLToPath = anyfn;
export const pathToFileURL = anyfn;
export const lookup = anyfn;
export const request = anyfn;
export const execFile = anyfn;
export const exec = anyfn;
export const promisify = () => anyfn;
export const readFile = anyfn;
export const readlink = anyfn;
export const rename = anyfn;
export const rm = anyfn;
export const symlink = anyfn;
export const unlink = anyfn;
export const writeFile = anyfn;
export const mkdir = anyfn;
export const stat = anyfn;
export const readdir = () => [];
export const isIP = () => 0;
export const statfsSync = anyfn;
export const cp = anyfn;
export const unlinkSync = anyfn;
export class AsyncLocalStorage {
  run(_store, fn, ...args) {
    return fn(...args);
  }
  getStore() {
    return undefined;
  }
}`,
      loader: "js",
    }));
  },
};

// Not every @elizaos/{shared,ui} subpath export carries the `eliza-source`
// condition — several map only to dist/, which does not exist in a fresh
// checkout. Resolve them straight into the package sources.
const elizaSourceAliasPlugin = {
  name: "eliza-source-alias",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^@elizaos\/(shared|ui)(\/.*)?$/ },
      async (args) => {
        if (args.namespace === "eliza-source-alias") return undefined;
        const m = args.path.match(/^@elizaos\/(shared|ui)(?:\/(.*))?$/);
        const pkgSrc = join(repoRoot, "packages", m[1], "src");
        const sub = m[2] ?? "index";
        return pluginBuild.resolve(`./${sub}`, {
          resolveDir: pkgSrc,
          kind: args.kind,
          namespace: "eliza-source-alias",
        });
      },
    );
  },
};

// Optional wallet-connector deps that wagmi lazily requires but which are not
// installed (and never execute in this harness) — stub them inert.
const optionalDepStubPlugin = {
  name: "optional-dep-stub",
  setup(pluginBuild) {
    const filter = /^(@metamask\/connect-evm|@base-org\/account|@safe-global\/safe-apps-sdk|@safe-global\/safe-apps-provider|cbw-sdk|porto(\/.*)?)$/;
    pluginBuild.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "optional-dep-stub",
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "optional-dep-stub" },
      () => ({
        contents: "export default {};",
        loader: "js",
      }),
    );
  },
};

const bundle = await build({
  entryPoints: [join(here, "slop-removal-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "empty" },
  // Resolve @elizaos/* package exports from source — the fresh-checkout dist
  // does not exist (same condition the cloud-e2e runner passes to bun).
  conditions: ["eliza-source"],
  define: {
    "process.env.NODE_ENV": '"production"',
    // iife leaves import.meta empty; a few sources read import.meta.env
    // without optional chaining. Point it at a page-provided empty object.
    "import.meta.env": "globalThis.__VITE_ENV__",
  },
  tsconfig: bareTsconfig,
  plugins: [elizaSourceAliasPlugin, nodeStubPlugin, optionalDepStubPlugin],
  write: false,
});
const js = bundle.outputFiles[0].text;

const pageHtml = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cloud slop-removal e2e</title>
<style>${css}</style>
</head><body><div id="root"></div>
<script>
  window.global = window;
  // The gates' Playwright test-auth bypass (same mechanism as the cloud-e2e
  // runner): the SIWE-minted eliza_* key is a Bearer API key, not a decodable
  // Steward JWT, so the session hooks resolve the test user while the api
  // client sends the REAL key for data.
  window.__VITE_ENV__ = { VITE_PLAYWRIGHT_TEST_AUTH: "true" };
  document.cookie = "eliza-test-auth=1";
  window.process = {
    env: { NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH: "true" },
    platform: "browser", cwd: () => "/", versions: {},
  };
  localStorage.setItem("steward_session_token", ${JSON.stringify(KEY)});
</script>
<script>${js.replace(/<\/script>/g, "<\\/script>")}</script></body></html>`;

const pageServer = Bun.serve({
  hostname: "127.0.0.1",
  port: PAGE_PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await fetch(`${API_BASE}${url.pathname}${url.search}`, {
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
    // Serve the SPA for every non-API path so BrowserRouter deep links work.
    return new Response(pageHtml, {
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
page.on("pageerror", (err) => {
  console.log("  [pageerror]", err.message?.slice(0, 500));
});

let shot = 0;
async function snap(name, target = page) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await target.screenshot({ path: join(outDir, file), fullPage: true });
  console.log(`  📸 ${file}`);
}

const ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;

// --- leg 1: legacy deep links → canonical settings homes ---------------------

const redirectCases = [
  ["/dashboard/billing", "/settings#cloud-billing", "cloud-billing"],
  [
    "/dashboard/billing?canceled=true",
    "/settings?canceled=true#cloud-billing",
    "cloud-billing",
  ],
  ["/dashboard/earnings", "/settings#cloud-monetization", "cloud-monetization"],
  [
    "/dashboard/monetization",
    "/settings#cloud-monetization",
    "cloud-monetization",
  ],
  [
    "/dashboard/affiliates",
    "/settings#cloud-monetization",
    "cloud-monetization",
  ],
  ["/dashboard/account", "/settings#cloud-account", "cloud-account"],
  ["/dashboard/security", "/settings#cloud-security", "cloud-security"],
  [
    "/dashboard/security/permissions",
    "/settings#cloud-plugin-grants",
    "cloud-plugin-grants",
  ],
  ["/dashboard/api-keys", "/settings#cloud-api-keys", "cloud-api-keys"],
  [
    "/dashboard/settings?tab=connections",
    "/settings?tab=connections#cloud-connectors",
    "cloud-connectors",
  ],
  [
    "/dashboard/settings?tab=billing",
    "/settings?tab=billing#cloud-billing",
    "cloud-billing",
  ],
  // Legacy hash aliases carried by old links/bookmarks resolve too.
  ["/settings#billing", "/settings#billing", "cloud-billing"],
  ["/settings#api-keys", "/settings#api-keys", "cloud-api-keys"],
];

console.log("== leg 1: compat redirects ==");
for (const [from, expectedLoc, expectedSection] of redirectCases) {
  await page.goto(`${ORIGIN}${from}`, { waitUntil: "load" });
  await page.getByTestId("probe-location").waitFor({ timeout: 30_000 });
  const loc = await page.getByTestId("probe-location").innerText();
  const section = await page.getByTestId("probe-section").innerText();
  assert(
    loc === expectedLoc,
    `${from} lands on ${expectedLoc} (got ${loc})`,
  );
  assert(
    section === expectedSection,
    `${from} resolves settings section ${expectedSection} (got ${section})`,
  );
  await snap(`redirect-${from.replace(/[/?#=]+/g, "-").replace(/^-|-$/g, "")}`);
}

// --- leg 2: the canonical settings sections render real data -----------------

console.log("== leg 2: canonical settings sections ==");

// Billing + the relocated ?canceled=true banner.
await page.goto(`${ORIGIN}/?surface=billing&canceled=true`);
await page
  .getByText("Payment canceled. No charges were made.")
  .waitFor({ timeout: 60_000 });
assert(true, "billing section shows the relocated checkout-canceled banner");
await page.waitForTimeout(1500);
await snap("surface-billing-canceled-desktop");

await page.goto(`${ORIGIN}/?surface=billing`);
await page.waitForTimeout(4000);
const billingHasBanner = await page
  .getByText("Payment canceled. No charges were made.")
  .count();
assert(
  billingHasBanner === 0,
  "billing section hides the canceled banner without ?canceled",
);
await snap("surface-billing-desktop");

// Monetization: merged Earnings + Affiliates tabs.
await page.goto(`${ORIGIN}/?surface=monetization`);
await page.getByRole("tab", { name: /Earnings/i }).waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
await snap("surface-monetization-earnings-desktop");
await page.getByRole("tab", { name: /Affiliates/i }).click();
await page.waitForTimeout(2500);
await snap("surface-monetization-affiliates-desktop");

// Security: panels + the hash-anchor links to sibling sections.
await page.goto(`${ORIGIN}/?surface=security`);
await page
  .getByRole("link", { name: /Plugin permissions/i })
  .waitFor({ timeout: 60_000 });
await page.waitForTimeout(2000);
await snap("surface-security-desktop");
await page.getByRole("link", { name: /Plugin permissions/i }).click();
const secHash = await page.evaluate(() => window.location.hash);
assert(
  secHash === "#cloud-plugin-grants",
  `security → plugin-grants anchor sets the section hash (got ${secHash})`,
);
const manageKeysHref = await page
  .getByRole("link", { name: /Manage keys/i })
  .first()
  .getAttribute("href")
  .catch(() => null);
assert(
  manageKeysHref === "#cloud-api-keys",
  `security → Manage keys anchor targets #cloud-api-keys (got ${manageKeysHref})`,
);

// API keys section.
await page.goto(`${ORIGIN}/?surface=api-keys`);
await page.getByTestId("surface-api-keys").waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
await snap("surface-api-keys-desktop");

// Account section.
await page.goto(`${ORIGIN}/?surface=account`);
await page.getByTestId("surface-account").waitFor({ timeout: 60_000 });
await page.waitForTimeout(3000);
await snap("surface-account-desktop");

// --- mobile pass over the two most-changed surfaces --------------------------
const mobile = await context.browser().newContext({
  viewport: { width: 390, height: 844 },
});
const mpage = await mobile.newPage();
await mpage.goto(`${ORIGIN}/?surface=billing&canceled=true`);
await mpage
  .getByText("Payment canceled. No charges were made.")
  .waitFor({ timeout: 60_000 });
await mpage.waitForTimeout(1500);
shot += 1;
await mpage.screenshot({
  path: join(outDir, `${String(shot).padStart(2, "0")}-surface-billing-canceled-mobile.png`),
  fullPage: true,
});
await mpage.goto(`${ORIGIN}/?surface=monetization`);
await mpage.getByRole("tab", { name: /Earnings/i }).waitFor({ timeout: 60_000 });
await mpage.waitForTimeout(2500);
shot += 1;
await mpage.screenshot({
  path: join(outDir, `${String(shot).padStart(2, "0")}-surface-monetization-mobile.png`),
  fullPage: true,
});
await mobile.close();

await context.close();
await browser.close();

// Normalize the recorded walkthrough name and write the machine-readable result.
const { readdirSync, renameSync } = await import("node:fs");
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".webm") && f !== "walkthrough.webm") {
    renameSync(join(outDir, f), join(outDir, "walkthrough.webm"));
  }
}
await writeFile(
  join(outDir, "RESULT.json"),
  `${JSON.stringify(
    {
      issue: 11341,
      failures,
      screenshots: shot,
      redirectCases: redirectCases.map(([from, to]) => ({ from, to })),
      ranAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED — output in ${outDir}`
    : `\n${failures} CHECK(S) FAILED — output in ${outDir}`,
);
process.exit(failures === 0 ? 0 : 1);
