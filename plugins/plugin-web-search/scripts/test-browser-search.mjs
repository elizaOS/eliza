/** Exercises a real installed Chromium extension and native host against a background fixture tab. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";
import { BrowserService } from "../../plugin-browser/src/browser-service.ts";
import { NativeSocketBrowserTarget } from "../../plugin-browser/src/native-socket-target.ts";
import { searchBrowserFirstWeb } from "../src/browser-web-search.ts";

const require = createRequire(new URL("../../plugin-browser/package.json", import.meta.url));
const { default: puppeteer } = require("puppeteer-core");
const root = resolve(import.meta.dirname, "../../../packages/browser-bridge-extension");
const temporary = await mkdtemp(join(tmpdir(), "eliza-native-browser-"));
const profile = join(temporary, "profile");
await mkdir(profile, { mode: 0o700 });
const diagnostics = [];
const target = new NativeSocketBrowserTarget((error) => diagnostics.push(error.message));
let browser;
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
        { encoding: "utf8" }
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
    assert.ok(await target.available(), `Native connection missing: ${diagnostics.join("; ")}`);
    const runtime = {
        getSetting: () => undefined,
        getCache: async () => ({ targetId: target.id, profileId: target.getProfileId() }),
        reportError: (_scope, error) => diagnostics.push(error.message),
        getService: () => service,
    };
    const service = new BrowserService(runtime);
    service.registerTarget(target);
    let report;
    try {
        const result = await searchBrowserFirstWeb(runtime, "elizaOS open source agent framework", {
            resultCount: 6,
            fetchImpl: async () => {
                throw new Error("Unexpected provider fallback after native selection");
            },
        });
        assert.equal(result.provider, "browser");
        const observed = JSON.parse(result.text);
        assert.equal(observed.browser.profileId, target.getProfileId());
        assert.ok(observed.results.length > 0);
        report = { success: true, browser: await browser.version(), observed, diagnostics };
    } catch (error) {
        report = {
            success: false,
            browser: await browser.version(),
            error: error.message,
            context: error.context,
            pages: await Promise.all(
                (await browser.pages()).map(async (page) => ({
                    url: page.url(),
                    title: await page.title(),
                }))
            ),
            diagnostics,
        };
        process.exitCode = 1;
    }
    await mkdir(testOutputPath("browser-search"), { recursive: true });
    await writeFile(
        testOutputPath("browser-search", "linux-integration.json"),
        JSON.stringify(report, null, 2)
    );
    process.stdout.write(
        `${JSON.stringify({ ...report, observed: report.observed ? { browser: report.observed.browser, resultCount: report.observed.results.length } : undefined })}\n`
    );
} finally {
    await browser?.close();
    await target.stop();
    await rm(temporary, { recursive: true, force: true });
}
