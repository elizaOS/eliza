import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const extensionDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "extension");
const packed = path.join(tmpdir(), "Valhalla-Chrome-Extension.zip");
const unpacked = await mkdtemp(path.join(tmpdir(), "valhalla-ext-"));
const errors = [];

function fail(message) {
  console.error(message);
  process.exit(1);
}

execFileSync(
  "zip",
  ["-r", packed, "manifest.json", "popup.html", "popup.js", "background.js", "icons"],
  { cwd: extensionDir }
);
const listing = execFileSync("unzip", ["-Z1", packed], { encoding: "utf8" });
const names = listing.split("\n").map((line) => line.trim()).filter(Boolean);
if (!names.includes("manifest.json")) fail("manifest.json is not at the zip root");
if (names.some((name) => name.startsWith("extension/"))) fail("zip nests the extension folder");
for (const required of ["popup.html", "popup.js", "background.js", "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"]) {
  if (!names.includes(required)) fail(`zip is missing ${required}`);
}
execFileSync("unzip", ["-q", packed, "-d", unpacked]);

const manifest = JSON.parse(await readFile(path.join(unpacked, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) fail("manifest is not MV3");
if (manifest.background?.service_worker !== "background.js") fail("service worker missing");
if (manifest.action?.default_popup !== "popup.html") fail("popup missing");
const popupHtml = await readFile(path.join(unpacked, "popup.html"), "utf8");
if (/<script[^>]+src=["']https?:/i.test(popupHtml)) fail("popup loads a remote script");
for (const size of [16, 32, 48, 128]) {
  const icon = await stat(path.join(unpacked, "icons", `icon-${size}.png`));
  if (icon.size < 50) fail(`icon-${size}.png is empty`);
}

const profile = path.join(unpacked, "profile");
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`],
});
context.on("serviceworker", (worker) => {
  worker.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const worker = context.serviceWorkers()[0];
if (!worker) {
  await context.close();
  fail("Extension service worker did not start");
}
const id = new URL(worker.url()).host;
const popup = await context.newPage();
popup.on("pageerror", (err) => errors.push(err.message));
popup.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
const response = await popup.goto(`chrome-extension://${id}/popup.html`);
if (!response || !response.ok()) fail("Popup did not load");
await popup.waitForSelector("h1");
const title = await popup.locator("h1").innerText();
if (!title.includes("VALHALLA")) fail("Popup title missing");
const csp = response.headers()["content-security-policy"] ?? "";
if (csp && /script-src[^;]*unsafe-eval/.test(csp)) fail("popup CSP allows unsafe-eval");
if (errors.length) fail(errors.join("\n"));
await context.close();
await rm(unpacked, { recursive: true, force: true });
console.log("Extension loaded", id);
