/** Real Chromium engine tests; only local HTTP fixtures, no malicious sites. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { buildBrowserProtection } from "./build.mjs";
import { compileThreatRules } from "./policy.mjs";

const dir = await mkdtemp(join(tmpdir(), "eliza-protection-")),
  extension = join(dir, "extension");
let context;
let blockedRequests = 0;
const server = http.createServer((req, res) => {
  if (
    req.headers.host.startsWith("blocked.") ||
    req.headers.host.startsWith("otherblocked.")
  )
    blockedRequests++;
  if (req.url === "/redirect") {
    res.writeHead(302, {
      location: `http://blocked.example.test:${server.address().port}/redirected`,
    });
    return res.end();
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    `<h1>Controlled website</h1><a href="http://blocked.example.test:${server.address().port}/linked">Threat link</a><iframe src="http://blocked.example.test:${server.address().port}/frame"></iframe><img src="http://blocked.example.test:${server.address().port}/image"><a target="_blank" href="http://otherblocked.example.test:${server.address().port}/popup">Threat popup</a>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  await buildBrowserProtection(extension);
  // Replace only feed transport in this temporary test extension. Service workers
  // require static module imports; prepend the mock before startup executes.
  const original = await readFile(join(extension, "background.mjs"), "utf8");
  await writeFile(
    join(extension, "background.mjs"),
    `globalThis.fetch=async()=>new Response('# Last modified: '+new Date().toUTCString()+'\\nblocked.example.test\\notherblocked.example.test\\n'+Array.from({length:1001},(_,i)=>'fixture'+i+'.invalid').join('\\n'),{headers:{'last-modified':new Date().toUTCString()}});\n` +
      original,
  );
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    timeout: 60000,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP *.example.test* 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  context.setDefaultTimeout(60000);
  console.log("Chromium launched");
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  console.log("Protection worker ready");
  await worker.evaluate(async () => {
    for (let i = 0; i < 100; i++) {
      const { protection } = await chrome.storage.local.get("protection");
      if (protection?.status === "current") return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Protection did not initialize");
  });
  console.log("Rules installed");
  const page = await context.newPage(),
    base = `http://allowed.example.test:${server.address().port}`;
  await page.goto(base);
  await page.getByRole("heading", { name: "Controlled website" }).waitFor();
  assert.equal(
    blockedRequests,
    0,
    "subframe and image must be denied before server",
  );
  await page.getByRole("link", { name: "Threat link", exact: true }).click();
  await page
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(blockedRequests, 0);
  await page.getByText("I think this is a mistake", { exact: true }).click();
  await page.getByRole("button", { name: "Open anyway…" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(blockedRequests, 0);
  // Keyboard recovery and large-text layout on a narrow browser viewport.
  await page.getByRole("button", { name: "Open anyway…" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "cancel");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "ask");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.addStyleTag({ content: ":root{font-size:44px}" });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "200% text must not cause horizontal scrolling",
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addStyleTag({ content: ":root{font-size:22px}" });
  await mkdir(testOutputPath("browser-protection"), { recursive: true });
  await page.screenshot({
    path: testOutputPath("browser-protection", "warning.png"),
  });
  await page.goto(
    `http://blocked.example.test.:${server.address().port}/dotted`,
  );
  await page
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(
    blockedRequests,
    0,
    "trailing-dot domain must not bypass blocking",
  );
  await page.goto(base + "/redirect");
  await page
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(
    blockedRequests,
    0,
    "redirect destination must not receive request",
  );
  await page.goto(base);
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: "Threat popup" }).click();
  const popup = await popupPromise;
  await popup
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(blockedRequests, 0, "popup blocked before network");
  await popup.close();
  await page.goto(
    `http://blocked.example.test:${server.address().port}/confirmed`,
  );
  await page.getByText("I think this is a mistake", { exact: true }).click();
  await page.getByRole("button", { name: "Open anyway…" }).click();
  await page
    .getByRole("button", { name: "Open this page temporarily" })
    .click();
  await page.getByRole("heading", { name: "Controlled website" }).waitFor();
  assert.equal(
    blockedRequests,
    1,
    "only confirmed document loads; embedded requests stay denied",
  );
  await page.reload();
  await page
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(blockedRequests, 1, "exception removed after commit");
  await context.close();
  context = null;
  await writeFile(
    join(extension, "background.mjs"),
    `globalThis.fetch=async()=>{throw Error('Offline fixture');};\n` + original,
  );
  context = await chromium.launchPersistentContext(join(dir, "profile"), {
    channel: "chromium",
    headless: true,
    timeout: 60000,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP *.example.test* 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  context.setDefaultTimeout(60000);
  const restarted = await context.newPage();
  await restarted.goto(
    `http://blocked.example.test:${server.address().port}/offline`,
  );
  await restarted
    .getByRole("heading", {
      name: "This website has been reported as harmful.",
    })
    .waitFor();
  assert.equal(
    blockedRequests,
    1,
    "persisted engine rules protect offline restart",
  );
  worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const engineId = new URL(worker.url()).hostname;
  const capacityRules = compileThreatRules(
    Array.from({ length: 600001 }, (_, i) => `capacity${i}.invalid`),
    engineId,
  );
  await worker.evaluate(async (addRules) => {
    const current = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.map((r) => r.id),
      addRules,
    });
  }, capacityRules);
  console.log(
    "PASS: 600,001-domain policy installed atomically in Chromium; offline restart preserved blocking.",
  );
  console.log(
    "PASS: engine blocks links, redirects, popups, subframes and images before network; confirmed exact-page exception expires after commit.",
  );
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
