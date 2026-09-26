/** Exercises a real installed Chromium extension and native host against a background fixture tab. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NativeSocketBrowserTarget } from "../../../plugins/plugin-browser/src/native-socket-target.ts";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const require = createRequire(
  new URL("../../../plugins/plugin-browser/package.json", import.meta.url),
);
const { default: puppeteer } = require("puppeteer-core");
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "eliza-native-browser-"));
const profile = join(temporary, "profile");
await mkdir(profile, { mode: 0o700 });
const diagnostics = [];
const target = new NativeSocketBrowserTarget((error) =>
  diagnostics.push(error.message),
);
let browser;
const longText = "Complete multilingual browser context 最後🙂 ".repeat(20000);
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/frame")
    return res.end("<p>Complete child frame context</p>");
  if (req.url === "/inaccessible")
    return res.end(
      '<p>Parent context</p><iframe sandbox src="data:text/html,%3Cp%3EInaccessible%20child%20context%3C/p%3E"></iframe>',
    );
  res.end(
    `<title>Native browser fixture</title><button id="increment" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Increment</button><span id="count">0</span><input id="name"><a href="https://example.com/">Source</a><pre>${longText}</pre><iframe src="/frame"></iframe>`,
  );
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
  await target.start({ XDG_RUNTIME_DIR: temporary });
  const install = spawnSync(
    process.execPath,
    [
      join(root, "scripts/install-native-host.mjs"),
      "--host",
      join(root, "scripts/native-host.mjs"),
      "--manifest-dir",
      join(profile, "NativeMessagingHosts"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr);
  browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium",
    headless: true,
    userDataDir: profile,
    env: { ...process.env, XDG_RUNTIME_DIR: temporary },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${join(root, "dist/chrome")}`,
      `--load-extension=${join(root, "dist/chrome")}`,
    ],
  });
  const deadline = Date.now() + 20000;
  while (!(await target.available()) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 100));
  assert.ok(
    await target.available(),
    `Native connection missing: ${diagnostics.join("; ")}`,
  );
  const opened = await target.execute({
    subaction: "open",
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  const id = opened.value.result.id;
  await new Promise((done) => setTimeout(done, 500));
  const snapshot = await target.execute({ subaction: "snapshot", id });
  const frame = snapshot.value.result.frames[0];
  assert.equal(snapshot.value.result.frames.length, 2);
  assert.ok(
    snapshot.value.result.frames.some(
      (frame) => frame.text === "Complete child frame context",
    ),
  );
  const listing = await target.execute({ subaction: "list" });
  assert.equal(
    listing.value.result.tabs.find((tab) => tab.id === id).active,
    false,
  );
  assert.ok(
    frame.text.includes(longText.trim()),
    "Native messaging must preserve the complete large page text",
  );
  const button = frame.elements.find(
    (element) => element.label === "Increment",
  );
  assert.ok(button);
  const receipt = await target.execute({
    subaction: "click",
    id,
    selector: button.selector,
  });
  assert.equal(receipt.value.result.completed, false);
  await assert.rejects(
    target.execute({ subaction: "click", id, selector: button.selector }),
    /fresh snapshot/,
  );
  const actualPage = (await browser.pages()).find((page) =>
    page.url().includes("127.0.0.1"),
  );
  assert.equal(
    await actualPage.$eval("#count", (node) => node.textContent),
    "1",
  );
  const fresh = await target.execute({ subaction: "snapshot", id });
  const input = fresh.value.result.frames[0].elements.find(
    (element) => element.tag === "input",
  );
  await target.execute({
    subaction: "fill",
    id,
    selector: input.selector,
    text: "Test exact profile",
  });
  assert.equal(
    await actualPage.$eval("#name", (node) => node.value),
    "Test exact profile",
  );
  const blocked = await target.execute({
    subaction: "open",
    url: `http://127.0.0.1:${server.address().port}/inaccessible`,
  });
  const sandboxed = await target.execute({
    subaction: "snapshot",
    id: blocked.value.result.id,
  });
  assert.equal(sandboxed.value.result.frames.length, 2);
  assert.ok(
    sandboxed.value.result.frames.some(
      (frame) => frame.text === "Inaccessible child context",
    ),
  );
  const report = {
    browser: await browser.version(),
    profileId: target.getProfileId(),
    completeTextCharacters: longText.length,
    backgroundTab: true,
    counterAfterClick: 1,
    staleReferenceRejected: true,
    nativeFillVerified: true,
    completeFrames: 2,
    sandboxedFrameIncluded: true,
    diagnostics,
  };
  await mkdir(testOutputPath("browser-native-control"), { recursive: true });
  await writeFile(
    testOutputPath("browser-native-control", "linux-integration.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser?.close();
  await target.stop();
  await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
