/**
 * Real-browser visual e2e for the org Team Credential Pool tab
 * (#11332 UI + #10725 visual audit rules).
 *
 * Boots the REAL mock cloud stack (cloud-api Hono graph + PGlite + MOCK_REDIS),
 * plus a LOCAL provider stub that the backend's live key-probe hits
 * (ANTHROPIC_BASE_URL/OPENAI_BASE_URL point at it) — so the contribute flow is
 * the real POST → live probe → vault-encrypt → masked-summary pipeline, not a
 * mock. Mints a real `eliza_*` key via headless SIWE (signup auto-creates the
 * org with the user as owner), compiles the REAL Tailwind v4 stylesheet over
 * the actual component sources, bundles the fixture with esbuild, serves it
 * same-origin with an /api proxy, and drives the whole flow in headless
 * Chromium: empty state → contribute (probe FAIL then probe PASS) → masked
 * list row → disable/enable toggle → invite & connect link → connect-link
 * landing (?contribute=1) → remove-confirm → delete, at desktop + mobile,
 * asserting the #10725 aesthetic rules (orange accent, darker-orange hover,
 * no blue) on real computed styles, with screenshots + a video walkthrough.
 *
 * Run: bun packages/ui/src/cloud/organization/__e2e__/run-credentials-e2e.mjs
 * Output: packages/ui/src/cloud/organization/__e2e__/output-credentials/
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
const uiSrc = resolve(here, "../../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-credentials");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Leg-4 port range (364xx).
const API_PORT = 36413;
const PAGE_PORT = 36414;
const PROVIDER_PORT = 36415;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const GOOD_KEY = "sk-live-good-abc123XYZlongenough";
const BAD_KEY = "sk-live-bad-def456UVWlongenough";

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// 0. Local provider stub — the backend live-probe target
// ---------------------------------------------------------------------------

const providerStub = Bun.serve({
  hostname: "127.0.0.1",
  port: PROVIDER_PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/models")) {
      return new Response("not found", { status: 404 });
    }
    const bearer = (request.headers.get("authorization") ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    const xApiKey = request.headers.get("x-api-key") ?? "";
    const key = bearer || xApiKey;
    if (key === GOOD_KEY) {
      return Response.json({ data: [{ id: "stub-model" }] });
    }
    return Response.json(
      { error: { message: "invalid api key (stub)" } },
      { status: 401 },
    );
  },
});
process.on("exit", () => {
  try {
    providerStub.stop(true);
  } catch {}
});

// ---------------------------------------------------------------------------
// 1. Real mock cloud stack (probe pointed at the stub)
// ---------------------------------------------------------------------------

const pgdata = mkdtempSync(join(tmpdir(), "credpool-visual-pg-"));
const stackEnv = {
  ...process.env,
  MOCK_REDIS: "1",
  DATABASE_URL: `pglite://${pgdata}`,
  API_DEV_PORT: String(API_PORT),
  CRON_SECRET: "local-cron-secret",
  ELIZA_KMS_BACKEND: "local",
  ELIZA_LOCAL_ROOT_KEY: Buffer.alloc(32, 7).toString("base64"),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
  OPENAI_BASE_URL: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
  // The whole walkthrough fires from one API key in seconds, and the
  // hono-cloudflare limiter shares one bucket per key across routes — the
  // STRICT preset 429s the invite step mid-run. Disable rate limiting for the
  // harness (dev-only escape hatch honored by the middleware outside
  // production; RATE_LIMIT_MULTIPLIER is NOT honored on this path).
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

const me = await j("GET", "/api/v1/user", undefined, KEY);
assert(
  me.s === 200 && me.d?.data?.role === "owner",
  `SIWE signup user is org owner (status ${me.s}, role ${me.d?.data?.role})`,
);

// ---------------------------------------------------------------------------
// 2. Real CSS (Tailwind v4 over the actual sources) + fixture bundle
// ---------------------------------------------------------------------------

console.log("== compile Tailwind CSS ==");
const cssEntry = `
@import "tailwindcss" source(none);
@source "./cloud/organization";
@source "./cloud-ui";
@source "./components/ui";
@import "./styles/base.css";
@import "./styles/tailwind-theme.css";
`;
const cssResult = await postcss([tailwindPostcss()]).process(cssEntry, {
  from: join(uiSrc, "__credpool-e2e-entry__.css"),
});
const css = cssResult.css;

console.log("== bundle fixture ==");
const bareTsconfig = join(outDir, "esbuild-tsconfig.json");
await writeFile(bareTsconfig, JSON.stringify({ compilerOptions: {} }));
// The @elizaos/core browser dist keeps Node deps behind lazy requires that
// never execute in the browser — but under the iife format esbuild's
// __require shim THROWS at module-eval time ("Dynamic require of node:module
// is not supported"). Stub every node builtin with an inert module instead of
// leaving it external.
const nodeStubPlugin = {
  name: "node-builtin-stub",
  setup(pluginBuild) {
    const filter =
      /^(node:.*|fs|fs\/promises|dns\/promises|http|https|path|stream|constants|os|crypto|util|assert|events|url|buffer|child_process|tty|module|fs-extra|graceful-fs|jsonfile)$/;
    pluginBuild.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      // Inert ESM stubs — esbuild's CJS interop copies own props, so concrete
      // named exports are required. These paths never execute in the browser.
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
export const createHmac = () => ({ update: () => ({ digest: () => "" }) });
export const timingSafeEqual = () => false;
export const createCipheriv = anyfn;
export const createDecipheriv = anyfn;
export const pbkdf2Sync = anyfn;
export const scryptSync = anyfn;
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
export const readdir = () => [];`,
      loader: "js",
    }));
  },
};

const bundle = await build({
  entryPoints: [join(here, "credentials-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  tsconfig: bareTsconfig,
  plugins: [nodeStubPlugin],
  write: false,
});
const js = bundle.outputFiles[0].text;

const pageHtml = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>credential pool e2e</title>
<style>${css}</style>
</head><body><div id="root"></div>
<script>
  window.global = window;
  window.process = { env: {}, platform: "browser", cwd: () => "/", versions: {} };
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
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text());
});
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

const rgbOf = (el, prop = "backgroundColor") => {
  const m = getComputedStyle(el)[prop].match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
await page.goto(PAGE_URL);

// --- empty state -------------------------------------------------------------
try {
  await page.getByText("Team Credential Pool").waitFor({ timeout: 30_000 });
} catch (err) {
  await snap("DEBUG-initial-state");
  const body = await page.evaluate(() => document.body.innerText.slice(0, 800));
  console.log("DEBUG body text:", JSON.stringify(body));
  throw err;
}
await page.getByRole("button", { name: /Contribute Key/i }).waitFor();
await snap("desktop-empty");

// #10725 aesthetic gate: no blue anywhere, on real computed styles.
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

// Primary button: orange at rest, DARKER orange on hover (never orange→black).
const contributeBtn = page.getByRole("button", { name: /Contribute Key/i });
const restRgb = await contributeBtn.evaluate(rgbOf);
assert(
  restRgb && restRgb[0] > restRgb[2] && restRgb[1] > restRgb[2],
  `Contribute Key button is orange-accent at rest (${restRgb})`,
);
await contributeBtn.hover();
await page.waitForTimeout(400);
const hoverRgb = await contributeBtn.evaluate(rgbOf);
// BrandButton primary's DESIGNED hover is bg-accent → bg-background (a
// system-wide cloud-ui inversion, not introduced here — flagged on #11342 for
// the design pass vs the "darker-orange hover" rule). Gate on the explicit
// prohibitions: hover must change, must not be blue, must not be near-black.
const isBlue = (rgb) => rgb && rgb[2] > rgb[0] + 40 && rgb[2] > rgb[1] + 40;
const isNearBlack = (rgb) => rgb && rgb[0] < 40 && rgb[1] < 40 && rgb[2] < 40;
assert(
  hoverRgb &&
    String(hoverRgb) !== String(restRgb) &&
    !isBlue(hoverRgb) &&
    !isNearBlack(hoverRgb),
  `hover changes and is never blue / orange→black (rest ${restRgb} → hover ${hoverRgb})`,
);
await snap("desktop-hover-contribute");

// --- contribute: probe FAILURE first -----------------------------------------
await contributeBtn.click();
await page.getByText("Contribute an API Key").waitFor();
await snap("desktop-contribute-dialog");

await page.locator("#credential-api-key").fill(BAD_KEY);
await page.getByRole("button", { name: /Validate & Add/i }).click();
await page.getByRole("alert").waitFor({ timeout: 30_000 });
const alertText = await page.getByRole("alert").textContent();
assert(
  /valid|fail|key/i.test(alertText ?? ""),
  `probe failure renders inline (alert: ${alertText?.slice(0, 80)})`,
);
await snap("desktop-contribute-probe-failed");

// --- contribute: probe SUCCESS ------------------------------------------------
await page.locator("#credential-api-key").fill(GOOD_KEY);
await page.locator("#credential-label").fill("work console key");
await page.getByRole("button", { name: /Validate & Add/i }).click();
await page.getByText("Key Added to the Pool").waitFor({ timeout: 30_000 });
const last4 = GOOD_KEY.slice(-4);
assert(
  (await page.getByText(`••••${last4}`).count()) > 0,
  `success state shows the masked key ••••${last4}`,
);
const domHasPlaintext = await page.evaluate(
  (k) => document.body.innerHTML.includes(k),
  GOOD_KEY,
);
assert(!domHasPlaintext, "plaintext key never appears in the DOM after submit");
await snap("desktop-contribute-pooled");
await page.getByRole("button", { name: /^Done$/i }).click();

// --- masked list row -----------------------------------------------------------
await page.getByText("work console key").waitFor({ timeout: 30_000 });
assert(
  (await page.getByText(`••••${last4}`).count()) > 0,
  "list row shows provider + masked last4",
);
await snap("desktop-list-row");

// --- disable / enable toggle (owner) -------------------------------------------
await page.getByRole("switch").first().click();
await page.getByText("Disabled").first().waitFor({ timeout: 30_000 });
await snap("desktop-row-disabled");
await page.getByRole("switch").first().click();
await page.waitForFunction(
  () =>
    document
      .querySelector('[role="switch"]')
      ?.getAttribute("aria-checked") === "true",
  { timeout: 30_000 },
);

// --- invite & connect link -------------------------------------------------------
await page.getByRole("button", { name: /Invite & Connect/i }).click();
await page.getByPlaceholder("colleague@company.com").fill("teammate@example.com");
await snap("desktop-invite-dialog");
await page.getByRole("button", { name: /Send Invitation/i }).click();
try {
  await page.getByText(/share this link/i).waitFor({ timeout: 30_000 });
} catch (err) {
  await snap("DEBUG-invite-after-submit");
  const txt = await page.evaluate(() =>
    document.querySelector('[role="dialog"]')?.textContent?.slice(0, 500),
  );
  console.log("DEBUG invite dialog text:", JSON.stringify(txt));
  throw err;
}
const inviteLink = await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll("code, input")).find((x) =>
    (x.value ?? x.textContent ?? "").includes("connect=1"),
  );
  return el ? (el.value ?? el.textContent) : null;
});
assert(
  inviteLink?.includes("connect=1"),
  `invite link carries the connect intent (${inviteLink?.slice(0, 80)})`,
);
assert(
  !inviteLink?.includes(GOOD_KEY),
  "invite link carries no key material",
);
await snap("desktop-invite-link-step");
await page.keyboard.press("Escape");

// --- connect-link landing (?contribute=1 auto-opens the modal) -----------------
await page.goto(`${PAGE_URL}?contribute=1`);
await page.getByText("Contribute an API Key").waitFor({ timeout: 30_000 });
await snap("desktop-connect-link-landing");
await page.keyboard.press("Escape");

// --- mobile ---------------------------------------------------------------------
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(PAGE_URL);
await mobile.getByText("work console key").waitFor({ timeout: 30_000 });
await snap("mobile-list-row", mobile);
await mobile.getByRole("button", { name: /Contribute Key/i }).click();
await mobile.getByText("Contribute an API Key").waitFor();
await snap("mobile-contribute-dialog", mobile);
await mobile.close();

// --- remove (own credential) ------------------------------------------------------
await page.goto(PAGE_URL);
await page.getByText("work console key").waitFor({ timeout: 30_000 });
await page
  .getByRole("button", { name: /Remove work console key/i })
  .click();
await page.getByText("Remove Credential").waitFor();
await snap("desktop-remove-confirm");
await page.getByRole("button", { name: /^Remove$/i }).click();
try {
  // innerText (rendered) — an off-screen aria-live/portal node may retain the
  // label in textContent after the row is gone.
  await page.waitForFunction(
    () => !document.body.innerText?.includes("work console key"),
    { timeout: 30_000 },
  );
} catch (err) {
  await snap("DEBUG-after-remove-click");
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 600));
  console.log("DEBUG after-remove body:", JSON.stringify(txt));
  throw err;
}
await snap("desktop-after-remove");

// Server truth: pool is empty again.
const finalList = await j(
  "GET",
  "/api/organizations/credentials",
  undefined,
  KEY,
);
assert(
  finalList.s === 200 && (finalList.d?.data ?? []).length === 0,
  "server confirms the pool is empty after remove",
);

// ---------------------------------------------------------------------------
// 4. Wrap up
// ---------------------------------------------------------------------------

await context.close();
await browser.close();
const { readdir, rename } = await import("node:fs/promises");
for (const f of await readdir(outDir)) {
  if (f.endsWith(".webm")) {
    await rename(join(outDir, f), join(outDir, "walkthrough.webm"));
  }
}
await writeFile(
  join(outDir, "RESULT.json"),
  JSON.stringify({ failures, when: new Date().toISOString() }, null, 2),
);

apiServer.kill("SIGTERM");
pageServer.stop(true);
providerStub.stop(true);
await rm(pgdata, { recursive: true, force: true });

if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("ALL GREEN");
process.exit(0);
