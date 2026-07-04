// One-shot live e2e for the Birdclaw view against a running dev stack.
// Usage: UI=http://127.0.0.1:2168 API=http://127.0.0.1:31437 OUT=/tmp/out \
//          node scripts/birdclaw-live-e2e.mjs
// Boots chromium, completes first-run (local → other provider) if shown,
// verifies the launcher lists Birdclaw, opens /birdclaw, exercises tabs, and
// captures desktop + phone screenshots plus console/network logs.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const UI = process.env.UI ?? "http://127.0.0.1:2168";
const API = process.env.API ?? "http://127.0.0.1:31437";
const OUT = process.env.OUT ?? "/tmp/birdclaw-e2e";
mkdirSync(OUT, { recursive: true });

const failures = [];
function check(name, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures.push(line);
}

// 1) API-side truth first.
const views = await fetch(`${API}/api/views`).then((r) => r.json());
const entry = (views.views || []).find((v) => v.id === "birdclaw");
check(
  "registry lists birdclaw view",
  Boolean(entry),
  JSON.stringify(entry?.path),
);
const status = await fetch(`${API}/api/birdclaw/status`).then((r) => r.json());
check(
  "birdclaw status installed",
  status?.status?.installed === true,
  `version=${status?.status?.version} counts=${JSON.stringify(status?.status?.counts)}`,
);

// Readiness gate: during deferred-plugin boot the agent's event loop is
// starved and every route crawls; drive the UI only once the data route
// answers quickly twice in a row.
for (let i = 0; i < 30; i++) {
  const t0 = Date.now();
  const ok = await fetch(`${API}/api/birdclaw/tweets?resource=home&limit=1`)
    .then((r) => r.ok)
    .catch(() => false);
  if (ok && Date.now() - t0 < 3000) {
    const t1 = Date.now();
    const again = await fetch(`${API}/api/birdclaw/status`)
      .then((r) => r.ok)
      .catch(() => false);
    if (again && Date.now() - t1 < 2000) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

const browser = await chromium.launch({ timeout: 120000 });

async function completeFirstRun(page) {
  const chooser = page.getByTestId("first-run-runtime-chooser");
  const visible = await chooser.isVisible({ timeout: 3000 }).catch(() => false);
  if (!visible) return "already-complete";
  await page.getByTestId("first-run-chooser-local").click({ timeout: 30000 });
  await page.getByTestId("first-run-provider-other").click({ timeout: 30000 });
  await chooser
    .waitFor({ state: "hidden", timeout: 45000 })
    .catch(() => chooser.waitFor({ state: "detached", timeout: 45000 }));
  return "completed";
}

async function drive(label, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  // Pin the agent base for this e2e stack: the shared dev laptop can have a
  // second dev agent on the default port, and the client's fallback would
  // resolve there (CORS-blocked) instead of this stack's API.
  await page.addInitScript((apiBase) => {
    window.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase };
  }, API);
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 60000 });
  const firstRun = await completeFirstRun(page);
  console.log(`[${label}] first-run: ${firstRun}`);
  await page.waitForTimeout(4000);

  // Launcher: the Birdclaw tile should be present somewhere on the surface.
  const launcherHasTile = await page
    .getByText("Birdclaw", { exact: true })
    .first()
    .isVisible({ timeout: 20000 })
    .catch(() => false);
  await page.screenshot({
    path: path.join(OUT, `${label}-launcher.png`),
    fullPage: false,
  });
  check(`[${label}] launcher shows Birdclaw tile`, launcherHasTile);

  // Open the view directly by path (same URL the tile navigates to).
  await page.goto(`${UI}/birdclaw`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);
  const timelineTab = page.getByText("Timeline", { exact: true }).first();
  const viewLoaded = await timelineTab
    .isVisible({ timeout: 30000 })
    .catch(() => false);
  check(
    `[${label}] /birdclaw renders the view (Timeline tab visible)`,
    viewLoaded,
  );
  // Wait out the loading state (a contended host can stall the first fetch
  // chain), then assert a row from the seeded archive is on screen.
  await page
    .getByText("Loading archive")
    .waitFor({ state: "hidden", timeout: 60000 })
    .catch(() => {});
  const rowVisible = await page
    .getByText("@sam", { exact: false })
    .first()
    .isVisible({ timeout: 20000 })
    .catch(() => false);
  check(`[${label}] timeline shows seeded archive rows (@sam)`, rowVisible);
  await page.screenshot({
    path: path.join(OUT, `${label}-timeline.png`),
    fullPage: false,
  });

  // Tab interactions: Mentions (needs-reply nudge) and Inbox.
  await page
    .getByText("Mentions", { exact: true })
    .first()
    .click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await page
    .getByText("Loading archive")
    .waitFor({ state: "hidden", timeout: 60000 })
    .catch(() => {});
  const nudge = await page
    .getByText(/needs? a reply/i)
    .first()
    .isVisible({ timeout: 20000 })
    .catch(() => false);
  check(`[${label}] mentions tab loads (needs-reply marker)`, nudge);
  await page.screenshot({
    path: path.join(OUT, `${label}-mentions.png`),
    fullPage: false,
  });

  await page
    .getByText("Inbox", { exact: true })
    .first()
    .click({ timeout: 10000 });
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, `${label}-inbox.png`),
    fullPage: false,
  });

  const fatal = consoleErrors.filter(
    (line) =>
      !line.includes("favicon") &&
      !line.includes("404") &&
      !line.includes("net::ERR_ABORTED") &&
      // App-shell chrome, not the view under test: the floating chat's
      // slash-command catalog load degrades gracefully by design ("omitting
      // them from the slash menu") when the agent is still warming up.
      !line.includes("useSlashCommandController"),
  );
  check(
    `[${label}] no fatal console errors`,
    fatal.length === 0,
    fatal.slice(0, 3).join(" | "),
  );
  writeFileSync(
    path.join(OUT, `${label}-console.json`),
    JSON.stringify(consoleErrors, null, 1),
  );
  await ctx.close();
}

await drive("desktop", { width: 1440, height: 900 });
await drive("phone", { width: 390, height: 844 });

await browser.close();
writeFileSync(
  path.join(OUT, "summary.json"),
  JSON.stringify({ failures, ok: failures.length === 0 }, null, 1),
);
console.log(
  failures.length === 0 ? "ALL PASS" : `FAILURES:\n${failures.join("\n")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
