/**
 * Accounts-UI e2e — real browser, real network, real API, real disk (#10722).
 *
 * What runs where:
 *   - API: `accounts-api-server.ts` under bun — the REAL `handleAccountsRoutes`
 *     (packages/agent) + REAL `AccountPool` (packages/app-core src, pinned via
 *     tsconfig.e2e-paths.json) over a scratch on-disk credential store.
 *   - UI: the REAL `AccountList` component tree (AccountCard, AddAccountDialog,
 *     RotationStrategyPicker, EditableAccountLabel, useAccounts, ElizaClient)
 *     esbuild-bundled with the real Tailwind theme and served from the SAME
 *     origin, so every fetch in the browser is a genuine network request into
 *     the real route handlers.
 *   - Driver: Playwright headless Chromium.
 *
 * Scenarios (assertions on OUTCOMES — DOM + pool + disk):
 *   01 empty state (no accounts connected)
 *   02 add dialog · 03 invalid API key rejected by the real zod validation
 *   04 account added (credential lands on disk) · 05 second account
 *   06 priority reorder via move-up (two PATCH swap)
 *   07 rotation strategy change (persisted to config)
 *   08 health states: rate-limited (with reset) + needs-reauth badges
 *   09 disable toggle · 10 delete confirm · 11 deleted (disk cleaned)
 *   12 empty state after removing every account · mobile viewport captures
 *
 * Screenshots + logs land in test-results/evidence/10722-accounts-ui-e2e/.
 * Exits non-zero on any failed assertion or page error.
 *
 * Run: node packages/app/e2e/accounts-ui/run-accounts-ui-e2e.mjs
 * Ports: 34110-34139 (workstream range 34100-34199).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindPostcss from "@tailwindcss/postcss";
import { build } from "esbuild";
import { chromium } from "playwright";
import postcss from "postcss";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const appDir = resolve(here, "../..");
const uiSrc = join(repoRoot, "packages", "ui", "src");
const evidenceDir = join(
  repoRoot,
  "test-results",
  "evidence",
  "10722-accounts-ui-e2e",
);
await mkdir(evidenceDir, { recursive: true });

let failures = 0;
const results = [];
function assert(cond, msg) {
  const line = `${cond ? "PASS" : "FAIL"}  ${msg}`;
  console.log(line);
  results.push(line);
  if (!cond) failures += 1;
  return cond;
}

// ── esbuild plugins (mirrors packages/ui __e2e__ runners) ───────────────────
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "").split("/")[0];
      if (
        args.path.startsWith("node:") ||
        nodeBuiltins.has(args.path) ||
        builtinModules.includes(bare)
      ) {
        return { path: args.path, namespace: "node-stub" };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents:
        "const n=()=>noop;const noop=new Proxy(n,{get:()=>noop});module.exports=noop;",
      loader: "js",
    }));
  },
};
const stubElizaCore = {
  name: "stub-eliza-core",
  setup(b) {
    b.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
      path: args.path,
      namespace: "eliza-core-stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
      contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy({}, { get: () => noop });
      `,
      loader: "js",
    }));
  },
};
// Swap ONLY the app-state barrel for the translator stub. The api barrel — the
// network layer under test — stays real.
const stubStateBarrel = {
  name: "stub-state-barrel",
  setup(b) {
    b.onResolve({ filter: /^(\.\.\/)+state$/ }, () => ({
      path: join(here, "accounts-fixture-state-stub.ts"),
    }));
  },
};

async function bundleFixture() {
  const result = await build({
    entryPoints: [join(here, "accounts-fixture.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [stubStateBarrel, stubElizaCore, stubNodeBuiltins],
    write: false,
    absWorkingDir: repoRoot,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

async function compileCss(bundleJsPath) {
  const input = `
@import "tailwindcss";
@import "${join(uiSrc, "styles/base.css")}";
@import "${join(uiSrc, "styles/tailwind-theme.css")}";
@source "${bundleJsPath}";
`;
  // `from` must live inside the repo so tailwind can resolve the `tailwindcss`
  // package by walking up to the workspace node_modules (the bundle itself
  // lives in a tmp dir).
  const from = join(here, "fixture-input.virtual.css");
  const result = await postcss([tailwindPostcss()]).process(input, { from });
  return result.css;
}

// ── build fixture assets ────────────────────────────────────────────────────
const workDir = await mkdtemp(join(tmpdir(), "accounts-ui-e2e-"));
const fixtureDir = join(workDir, "fixture");
const elizaHome = join(workDir, "eliza-home");
await mkdir(fixtureDir, { recursive: true });
await mkdir(elizaHome, { recursive: true });

const js = await bundleFixture();
const jsPath = join(fixtureDir, "fixture.js");
await writeFile(jsPath, js);
const css = await compileCss(jsPath);
await writeFile(join(fixtureDir, "fixture.css"), css);
await writeFile(
  join(fixtureDir, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>accounts-ui e2e</title>
<link rel="stylesheet" href="/fixture.css">
<style>html,body{margin:0;min-height:100%;background:var(--bg,#0b0b0b);color:var(--text,#eee)}</style>
<script>window.process=window.process||{env:{NODE_ENV:"production"},platform:"browser",cwd:function(){return "/"}};</script>
</head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`,
);
console.log(`fixture bundled (${js.length} bytes js, ${css.length} bytes css)`);

// ── boot the real accounts API server (bun) ─────────────────────────────────
const serverLog = [];
const child = spawn(
  "bun",
  [
    "--tsconfig-override",
    join(here, "tsconfig.e2e-paths.json"),
    join(here, "accounts-api-server.ts"),
  ],
  {
    cwd: appDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ELIZA_HOME: elizaHome,
      ELIZA_STATE_DIR: elizaHome,
      ACCOUNTS_E2E_PORT: process.env.ACCOUNTS_E2E_PORT || "34110",
      ACCOUNTS_E2E_FIXTURE_DIR: fixtureDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// Mirror the API child's output live (prefixed) AND collect it for the
// evidence log — a boot crash must print its own stack, not a bare
// "exited early (code 1)" with the cause buried in a file that the
// early-rejection path never wrote.
child.stderr.on("data", (d) => {
  for (const line of String(d).split("\n")) {
    if (line.trim()) {
      serverLog.push(line.trim());
      console.error(`[api] ${line.trim()}`);
    }
  }
});

const port = await new Promise((resolvePort, rejectPort) => {
  const timer = setTimeout(
    () => rejectPort(new Error("API server did not become ready in 60s")),
    60_000,
  );
  let buffer = "";
  child.stdout.on("data", (d) => {
    buffer += String(d);
    // Consume completed lines only: a chunk boundary can't split the
    // readiness JSON, and repeated chunks can't re-mirror earlier lines.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready && parsed.port) {
          clearTimeout(timer);
          resolvePort(parsed.port);
          return;
        }
      } catch {
        // Not the readiness line — mirror it like stderr so nothing the
        // server prints is invisible.
        if (line.trim()) {
          serverLog.push(line.trim());
          console.error(`[api] ${line.trim()}`);
        }
      }
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    rejectPort(new Error(`API server exited early (code ${code})`));
  });
});
const base = `http://127.0.0.1:${port}`;
console.log(`accounts API server ready at ${base}`);

async function control(method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const poolAccounts = async () =>
  (await control("GET", "/__e2e__/pool?providerId=anthropic-api")).body
    .accounts;

// ── drive the UI ────────────────────────────────────────────────────────────
const consoleLog = [];
const networkLog = [];
let shot = 0;
async function snap(page, name, fullPage = true) {
  shot += 1;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({
    path: join(evidenceDir, file),
    animations: "allow",
    fullPage,
  });
  console.log(`  screenshot ${file}`);
  return file;
}

const browser = await chromium.launch();
const pageErrors = [];
const desktopContext = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  recordVideo: { dir: evidenceDir, size: { width: 1280, height: 900 } },
});
const page = await desktopContext.newPage();
const desktopVideo = page.video();
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
page.on("request", (r) => {
  if (r.url().includes("/api/") || r.url().includes("/__e2e__/")) {
    networkLog.push(`> ${r.method()} ${r.url().replace(base, "")}`);
  }
});
page.on("response", (r) => {
  if (r.url().includes("/api/") || r.url().includes("/__e2e__/")) {
    networkLog.push(
      `< ${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`,
    );
  }
});

const labelTexts = () =>
  page.locator('button[title="Click to rename"] span').allTextContents();

async function addAccount(label, apiKey, { expectError = false } = {}) {
  await page.getByRole("button", { name: "Add account" }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("#add-account-label").fill(label);
  await dialog.locator("#add-account-apikey").fill(apiKey);
  await dialog.getByRole("button", { name: "Add account" }).click();
  if (expectError) {
    await dialog.locator('[role="alert"]').waitFor({ state: "visible" });
    return dialog;
  }
  await dialog.waitFor({ state: "hidden" });
  await page.locator(`text=${label}`).first().waitFor({ state: "visible" });
  return dialog;
}

try {
  // 01 — empty state.
  await page.goto(base);
  await page.locator("text=Accounts (0)").waitFor({ state: "visible" });
  assert(
    (await page.locator("text=No accounts yet").count()) === 1,
    "empty state renders when no accounts are connected",
  );
  await snap(page, "empty-state");

  // 02/03 — add dialog + invalid key rejected by the REAL zod schema (min 8).
  const dialog = await addAccount("Personal", "short", { expectError: true });
  await snap(page, "add-invalid-key-error");
  const alertText = await dialog.locator('[role="alert"]').textContent();
  assert(
    Boolean(alertText && alertText.trim().length > 0),
    `invalid API key (<8 chars) surfaces the server's validation error inline ("${alertText?.trim()}")`,
  );
  await dialog.getByRole("button", { name: "Try again" }).click();
  await dialog.locator("#add-account-apikey").waitFor({ state: "visible" });
  await snap(page, "add-dialog");

  // 04 — valid add → 201 → card renders, credential lands on disk.
  await dialog.locator("#add-account-label").fill("Personal");
  await dialog.locator("#add-account-apikey").fill("sk-ant-e2e-personal-0001");
  await dialog.getByRole("button", { name: "Add account" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.locator("text=Accounts (1)").waitFor({ state: "visible" });
  let accounts = await poolAccounts();
  assert(
    accounts.length === 1 && accounts[0].label === "Personal",
    "added account is in the REAL pool (label=Personal)",
  );
  const personalId = accounts[0].id;
  const cred = await control(
    "GET",
    `/__e2e__/credential?providerId=anthropic-api&accountId=${personalId}`,
  );
  assert(
    cred.body.exists === true,
    "credential record written to the on-disk store",
  );
  assert(
    (await page.locator("text=API key").count()) >= 1,
    "card shows the API-key source badge",
  );
  await snap(page, "account-added");

  // 05 — second account.
  await addAccount("Work", "sk-ant-e2e-work-0002");
  await page.locator("text=Accounts (2)").waitFor({ state: "visible" });
  assert(
    (await labelTexts()).join(",") === "Personal,Work",
    "cards render in priority order (Personal #0, Work #1)",
  );
  await snap(page, "two-accounts");

  // 06 — reorder: move Work up (two sequential PATCHes swap priorities).
  await page.locator('button[aria-label="Move up"]').nth(1).click();
  await page.waitForFunction(() => {
    const spans = Array.from(
      document.querySelectorAll('button[title="Click to rename"] span'),
    );
    return spans.map((s) => s.textContent).join(",") === "Work,Personal";
  });
  accounts = await poolAccounts();
  const byLabel = Object.fromEntries(accounts.map((a) => [a.label, a]));
  assert(
    byLabel.Work.priority === 0 && byLabel.Personal.priority === 1,
    "priority swap persisted through PATCH /api/accounts (Work #0, Personal #1)",
  );
  await snap(page, "reordered");

  // 07 — rotation strategy change persists to config.
  await page.locator("#rotation-strategy-anthropic-api").click();
  await snap(page, "strategy-menu-open", false);
  await page.getByRole("option", { name: /Round-robin/ }).click();
  await page.getByRole("listbox").waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const el = document.querySelector("#rotation-strategy-anthropic-api");
    return el?.textContent?.includes("Round-robin");
  });
  const cfg = await control("GET", "/__e2e__/config");
  assert(
    cfg.body.config.accountStrategies?.["anthropic-api"] === "round-robin",
    "strategy PATCH persisted via saveConfig (accountStrategies.anthropic-api=round-robin)",
  );
  await snap(page, "strategy-round-robin");

  // 08 — health states seeded through the REAL pool mutations (the same
  // markRateLimited/markNeedsReauth the runtime calls on upstream 429/401).
  await control("POST", "/__e2e__/seed-health", {
    providerId: "anthropic-api",
    accountId: byLabel.Work.id,
    mode: "rate-limited",
    untilMs: Date.now() + 2 * 60 * 60 * 1000,
    detail: "429 (upstream rate limit)",
  });
  await control("POST", "/__e2e__/seed-health", {
    providerId: "anthropic-api",
    accountId: personalId,
    mode: "needs-reauth",
    detail: "invalid_grant",
  });
  await page.reload();
  await page.locator("text=Rate-limited").waitFor({ state: "visible" });
  assert(
    (await page.locator("text=/Rate-limited \\(resets in .+\\)/").count()) ===
      1,
    "rate-limited badge shows the reset countdown from healthDetail.until",
  );
  assert(
    (await page.locator("text=Needs reauth").count()) === 1,
    "needs-reauth badge renders for the invalid-grant account",
  );
  accounts = await poolAccounts();
  assert(
    accounts.find((a) => a.id === byLabel.Work.id)?.health === "rate-limited" &&
      accounts.find((a) => a.id === personalId)?.health === "needs-reauth",
    "pool state matches the rendered badges (rate-limited + needs-reauth)",
  );
  await snap(page, "health-states");

  // Mobile viewport captures of the populated + health states.
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  mobile.on("pageerror", (e) => pageErrors.push(`mobile: ${String(e)}`));
  await mobile.goto(base);
  await mobile.locator("text=Rate-limited").waitFor({ state: "visible" });
  await snap(mobile, "mobile-health-states");
  await mobile.locator("#rotation-strategy-anthropic-api").click();
  await snap(mobile, "mobile-strategy-menu-open", false);
  await mobile.keyboard.press("Escape");
  await mobile.close();

  // 09 — disable toggle (PATCH enabled=false). Poll the REAL pool state until
  // the PATCH lands (bounded) instead of sleeping a fixed interval.
  await page.locator('[aria-label="Account enabled"]').first().click();
  const firstLabel = (await labelTexts())[0];
  let disabled;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    accounts = await poolAccounts();
    disabled = accounts.find((a) => a.label === firstLabel);
    if (disabled?.enabled === false) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(
    disabled?.enabled === false,
    `disable toggle persisted (enabled=false for "${firstLabel}")`,
  );
  await snap(page, "disabled-account");

  // 10/11 — delete flow: confirm dialog → credential + metadata removed.
  await page.locator('button[aria-label="Delete account"]').first().click();
  await page.locator("text=Remove this account?").waitFor({ state: "visible" });
  await snap(page, "delete-confirm");
  await page.getByRole("button", { name: "Remove account" }).click();
  await page.locator("text=Accounts (1)").waitFor({ state: "visible" });
  accounts = await poolAccounts();
  assert(accounts.length === 1, "deleted account left the pool");
  const goneId = [byLabel.Work.id, personalId].find(
    (id) => !accounts.some((a) => a.id === id),
  );
  const goneCred = await control(
    "GET",
    `/__e2e__/credential?providerId=anthropic-api&accountId=${goneId}`,
  );
  assert(
    goneCred.body.exists === false,
    "deleted account's on-disk credential was removed",
  );
  await snap(page, "after-delete");

  // 12 — removing the last account returns to the empty state.
  await page.locator('button[aria-label="Delete account"]').first().click();
  await page.getByRole("button", { name: "Remove account" }).click();
  await page.locator("text=Accounts (0)").waitFor({ state: "visible" });
  assert(
    (await page.locator("text=No accounts yet").count()) === 1,
    "empty state returns after all accounts are disconnected",
  );
  assert((await poolAccounts()).length === 0, "pool is empty on disk too");
  await snap(page, "empty-after-delete");

  assert(
    pageErrors.length === 0,
    `zero page errors across the whole flow${pageErrors.length ? `: ${pageErrors.join(" | ")}` : ""}`,
  );
} finally {
  await page.close();
  await desktopContext.close();
  if (desktopVideo) {
    await desktopVideo.saveAs(
      join(evidenceDir, "accounts-ui-walkthrough.webm"),
    );
  }
  await browser.close();
  child.kill("SIGTERM");
  await writeFile(
    join(evidenceDir, "frontend-console.log"),
    `${consoleLog.join("\n")}\n`,
  );
  await writeFile(
    join(evidenceDir, "frontend-network.log"),
    `${networkLog.join("\n")}\n`,
  );
  await writeFile(
    join(evidenceDir, "backend-server.log"),
    `${serverLog.join("\n")}\n`,
  );
  await writeFile(
    join(evidenceDir, "assertions.log"),
    `${results.join("\n")}\n`,
  );
  await rm(workDir, { recursive: true, force: true });
}

console.log(
  `\n${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`} — ${shot} screenshots in ${evidenceDir}`,
);
process.exit(failures === 0 ? 0 : 1);
