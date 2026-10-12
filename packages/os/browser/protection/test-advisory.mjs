/** Real Chromium/extension advisory flow on controlled local pages. No native transport claim. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { buildBrowserProtection, composeProtectionAssets } from "./build.mjs";
import { compileThreatRules } from "./policy.mjs";

const native = process.argv.includes("--native");
let target;
let allowInitialOwner;
const initialOwner = new Promise((resolve) => {
  allowInitialOwner = resolve;
});
const baseline = process.argv.includes("--baseline");
const output = testOutputPath("browser-advisory");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "browser-advisory-"));
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.setHeader("Content-Security-Policy", "style-src 'none'");
  response.end(
    '<!doctype html><title>Controlled website</title><h1>Controlled website</h1><label>Your note <input aria-label="Your note"></label><p>The website remains open while protection is unavailable.</p>',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://allowed.example.test:${server.address().port}`;
let context;
try {
  const extension = join(temporary, "extension");
  const profile = join(temporary, "profile");
  if (native) {
    assert.equal(baseline, false, "Native flow is not the disabled baseline");
    const { NativeSocketBrowserTarget } = await import(
      "../../../../plugins/plugin-browser/src/native-socket-target.ts"
    );
    target = new NativeSocketBrowserTarget(() => {});
    target.onProfileRegistered(async (registration) => {
      await initialOwner;
      if (registration.isCurrent())
        await target.setProtectionOwner("account-a");
    });
    await target.start({ XDG_RUNTIME_DIR: temporary });
    const built = spawnSync(
      "bun",
      [
        "run",
        "--cwd",
        new URL("../../", import.meta.url).pathname,
        "build:browser",
      ],
      { encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr);
    const directory = new URL("../dist/chrome/", import.meta.url);
    const assets = Object.fromEntries(
      await Promise.all(
        (await readdir(directory)).map(async (name) => [
          name,
          await readFile(new URL(name, directory)),
        ]),
      ),
    );
    const composed = await composeProtectionAssets(assets, {
      advisory: { referenceDomains: ["facebook.com"] },
      nativeAccountTransport: true,
    });
    await mkdir(extension);
    await Promise.all(
      Object.entries(composed).map(([name, data]) =>
        writeFile(join(extension, name), data),
      ),
    );
    const installed = spawnSync(
      process.execPath,
      [
        new URL("../scripts/install-native-host.mjs", import.meta.url).pathname,
        "--host",
        new URL("../scripts/native-host.mjs", import.meta.url).pathname,
        "--manifest-dir",
        join(profile, "NativeMessagingHosts"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(installed.status, 0, installed.stderr);
  } else {
    await buildBrowserProtection(extension, {
      advisory: baseline ? undefined : { referenceDomains: ["facebook.com"] },
    });
  }
  const workerPath = join(
    extension,
    native ? "protection.mjs" : "background.mjs",
  );
  const source = await readFile(workerPath, "utf8");
  await writeFile(
    workerPath,
    `globalThis.fetch=async()=>{throw Error("Controlled offline feed");};\n${source}\nglobalThis.testProtection=protection;\n`,
  );
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    env: { ...process.env, XDG_RUNTIME_DIR: temporary },
    headless: true,
    timeout: 60000,
    recordVideo: { dir: output, size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--host-resolver-rules=MAP *.example.test* 127.0.0.1,MAP faceb00k.com 127.0.0.1",
      "--no-proxy-server",
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  if (native) {
    const deadline = Date.now() + 20000;
    while (!(await target.available()) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      await target.available(),
      "Actual native messaging host registered",
    );
  }
  const setOwner = (owner) =>
    native
      ? target.setProtectionOwner(owner)
      : worker.evaluate(
          (owner) => testProtection.advisory.setOwner(owner),
          owner,
        );
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole("heading", { name: "Controlled website" }).waitFor();
  if (baseline) {
    await page.screenshot({ path: join(output, "before-desktop.png") });
    await page.setViewportSize({ width: 390, height: 850 });
    await page.screenshot({ path: join(output, "before-mobile.png") });
  } else {
    const tabId = await worker.evaluate(
      async () =>
        (await chrome.tabs.query({})).find((tab) =>
          tab.url?.includes("allowed.example.test"),
        ).id,
    );
    const inspect = () =>
      worker.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id, frameIds: [0] },
          world: "ISOLATED",
          func: () => {
            const shadow = globalThis.__elizaProtectionAdvisory?.shadow;
            if (!shadow) return null;
            const button = shadow.querySelector("button"),
              section = shadow.querySelector("section"),
              rect = button.getBoundingClientRect();
            return {
              text: section.textContent,
              disabled: button.disabled,
              button: {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
              },
              width: section.getBoundingClientRect().width,
              height: section.getBoundingClientRect().height,
              viewportHeight: innerHeight,
              viewport: innerWidth,
            };
          },
        });
        return result.result;
      }, tabId);
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        const state = await inspect();
        if (predicate(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error("Advisory state did not arrive");
    };
    await wait((state) => state?.text.includes("wasn’t scanned"));
    assert.equal(
      (await inspect()).disabled,
      true,
      "No account scope can be guessed by a page",
    );
    if (native) allowInitialOwner();
    else await setOwner("account-a");
    await wait((state) => state && !state.disabled);
    await page
      .getByRole("textbox", { name: "Your note" })
      .fill("Website is usable without a safety confirmation");
    await page.screenshot({ path: join(output, "unscanned-desktop.png") });
    // Brief holds make the recorded review walkthrough readable; assertions use state receipts.
    const hold = () => page.waitForTimeout(700);
    await hold();
    const click = async () => {
      const state = await inspect();
      await page.mouse.click(state.button.x, state.button.y);
    };
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        world: "ISOLATED",
        func: () =>
          globalThis.__elizaProtectionAdvisory.shadow
            .querySelector("button")
            .focus(),
      });
    }, tabId);
    await page.keyboard.press("Enter");
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    await hold();
    assert.equal(
      await page.getByRole("textbox").inputValue(),
      "Website is usable without a safety confirmation",
    );
    await click();
    await wait((state) => state?.text.includes("wasn’t scanned"));
    await click();
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    await hold();
    await page.reload();
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    const extensionId = await worker.evaluate(() => chrome.runtime.id);
    const rules = compileThreatRules(["allowed.example.test"], extensionId);
    await worker.evaluate(
      (rules) =>
        chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules }),
      rules,
    );
    await page.goto(`${base}/new-threat`);
    await page
      .getByRole("heading", {
        name: "This website has been reported as harmful.",
      })
      .waitFor();
    await hold();
    await worker.evaluate(
      (rules) =>
        chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: rules.map((rule) => rule.id),
        }),
      rules,
    );
    await page.goto(base);
    await wait((state) => state?.text.includes("wasn’t scanned"));
    await click();
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    await hold();
    await setOwner("account-b");
    await wait((state) => state?.text.includes("wasn’t scanned"));
    // A delayed old-owner metadata read cannot erase the new owner's acknowledgement.
    await worker.evaluate(async () => {
      const original = chrome.storage.local.get.bind(chrome.storage.local);
      let entered;
      const held = new Promise((resolve) => {
        entered = resolve;
      });
      chrome.storage.local.get = () =>
        new Promise((resolve) => {
          globalThis.releaseRead = () =>
            resolve({
              protection: {
                status: "current",
                updatedAt: Date.now(),
                publishedAt: Date.now(),
              },
            });
          entered();
        });
      globalThis.pendingAdvice = testProtection.advisory.refreshAll();
      await held;
      chrome.storage.local.get = original;
    });
    await setOwner("account-c");
    await click();
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    await worker.evaluate(async () => {
      releaseRead();
      await pendingAdvice;
    });
    await page.reload();
    await wait((state) => state?.text.includes("Marked as not suspicious"));
    await click();
    await wait((state) => state?.text.includes("wasn’t scanned"));
    // Page script cannot read the closed tree or forge a trusted acknowledgement click.
    assert.equal(
      await page.evaluate(() =>
        [...document.documentElement.children].some((node) => node.shadowRoot),
      ),
      false,
    );
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        world: "ISOLATED",
        func: () =>
          globalThis.__elizaProtectionAdvisory.shadow
            .querySelector("button")
            .click(),
      });
    }, tabId);
    assert.ok((await inspect()).text.includes("wasn’t scanned"));
    await page.goto(`http://faceb00k.com:${server.address().port}`);
    await wait((state) => state?.text.includes("pretending"));
    await page.getByRole("heading", { name: "Controlled website" }).waitFor();
    await page.setViewportSize({ width: 390, height: 850 });
    const mobile = await wait((state) => state?.width <= 390);
    assert.ok(mobile.width <= mobile.viewport);
    await page.screenshot({ path: join(output, "lookalike-mobile.png") });
    await worker.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        world: "ISOLATED",
        func: () => {
          document.documentElement.style.fontSize = "32px";
        },
      });
    }, tabId);
    const large = await inspect();
    assert.ok(
      large.width <= large.viewport,
      "200% text fits without horizontal overflow",
    );
    await page.screenshot({ path: join(output, "lookalike-large-text.png") });
    // The accessibility tree exposes the warning and its ordinary button.
    const cdp = await context.newCDPSession(page);
    const tree = await cdp.send("Accessibility.getFullAXTree");
    assert.ok(
      tree.nodes.some(
        (node) =>
          node.role?.value === "button" &&
          node.name?.value === "Mark as not suspicious",
      ),
    );
    if (native) {
      await target.stop();
    } else await setOwner(null);
    await wait((state) => state?.disabled);
    // A current list removes unavailable advice, but not a lookalike signal.
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        protection: {
          status: "current",
          updatedAt: Date.now(),
          publishedAt: Date.now(),
        },
      });
      await testProtection.advisory.refreshAll();
    });
    await wait((state) => state?.text.includes("pretending"));
    await page.goto(base);
    await wait((state) => state === null);
  }
  const video = page.video();
  await context.close();
  if (!baseline)
    await writeFile(join(output, "walkthrough-path.txt"), await video.path());
  context = null;
  console.log(
    baseline
      ? "BASELINE captured default protection without optional advisory."
      : `PASS actual Chromium: offline navigation, trusted acknowledgement/undo, reload, owner reset, forged click refusal, nonblocking lookalike, mobile geometry, accessibility and current-list clearing. ${native ? "Linux native messaging account transport and disconnect reset passed. Android acceptance remains separate." : "Native host and Android acceptance remain separate."}`,
  );
} finally {
  await context?.close();
  await target?.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
