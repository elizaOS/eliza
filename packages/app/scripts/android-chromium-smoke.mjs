#!/usr/bin/env node
/** Captures public website behavior on a real Android Chromium instance; reports observations without claiming authenticated compatibility. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    port: { type: "string", default: "19224" },
    baseline: { type: "boolean", default: false },
  },
});
if (!values.serial || !/^\d+$/.test(values.port))
  throw new Error("Use --serial DEVICE [--port CDP_PORT] [--baseline].");
const port = Number(values.port);
if (port < 1024 || port > 65535)
  throw new Error("CDP port must be between 1024 and 65535.");
const adb = (...args) =>
  execFileSync("adb", ["-s", values.serial, ...args], { timeout: 30_000 });
const output = testOutputPath(
  "android-chromium",
  values.baseline ? "baseline" : "launcher",
);
await mkdir(output, { recursive: true });
const sites = [
  ["google", "https://www.google.com/"],
  ["facebook", "https://www.facebook.com/"],
  ["instagram", "https://www.instagram.com/"],
  ["whatsapp", "https://web.whatsapp.com/"],
];
const report = {
  serial: values.serial,
  timestamp: new Date().toISOString(),
  launcher: !values.baseline,
  authenticatedFlows: "not tested; user owns sign-in",
  fingerprint: adb("shell", "getprop", "ro.build.fingerprint")
    .toString()
    .trim(),
  results: [],
};

for (const [name, url] of sites) {
  const entry = { name, requestedUrl: url };
  let connection;
  let createdPage;
  try {
    adb("forward", `tcp:${port}`, "localabstract:chrome_devtools_remote");
    const previousTargetsResponse = await fetch(
      `http://127.0.0.1:${port}/json/list`,
    );
    if (!previousTargetsResponse.ok)
      throw new Error("Cannot inventory existing Chromium targets.");
    const previousTargets = new Set(
      (await previousTargetsResponse.json()).map((target) => target.id),
    );
    if (values.baseline) {
      adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url,
        "-p",
        "org.chromium.chrome",
      );
    } else {
      adb(
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url,
        "-n",
        "ai.elizaos.app/.ElizaBrowserActivity",
      );
    }
    adb("forward", `tcp:${port}`, "localabstract:chrome_devtools_remote");
    connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 20_000,
    });
    const deadline = Date.now() + 20_000;
    let page;
    while (!page && Date.now() < deadline) {
      const candidates = connection
        .contexts()
        .flatMap((context) => context.pages())
        .filter((candidate) => {
          const host = new URL(candidate.url()).hostname;
          const domain = `${name}.com`;
          return host === domain || host.endsWith(`.${domain}`);
        });
      for (const candidate of candidates) {
        const session = await candidate.context().newCDPSession(candidate);
        const { targetInfo } = await session.send("Target.getTargetInfo");
        await session.detach();
        if (
          !previousTargets.has(targetInfo.targetId) &&
          (await candidate.evaluate(
            () => document.visibilityState === "visible",
          ))
        ) {
          page = candidate;
          createdPage = candidate;
          break;
        }
      }
      if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!page)
      throw new Error(
        "No Chromium page matched the dispatched website; complete first-run setup and retry.",
      );
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.waitForFunction(
      (site) => {
        if (site === "google")
          return (
            document.querySelector('textarea[name="q"], input[name="q"]') !==
            null
          );
        const text = document.body.innerText;
        return site === "whatsapp"
          ? /scan.*(?:log in|QR)|link with phone number/i.test(text) &&
              !text.includes("from a browser on your computer")
          : /log in|login|sign up|create.*account/i.test(text);
      },
      name,
      { timeout: 30_000 },
    );
    // Android's native compositor may still show the splash after DOM readiness.
    // Wait for accessibility idle as well, then preserve its public-page tree.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    adb("shell", "uiautomator", "dump", "/sdcard/eliza-browser-public.xml");
    await writeFile(
      `${output}/${name}-accessibility.xml`,
      adb("shell", "cat", "/sdcard/eliza-browser-public.xml"),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    entry.observed = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      secureContext: isSecureContext,
      cookiesEnabled: navigator.cookieEnabled,
      serviceWorker: "serviceWorker" in navigator,
      passkeyApi: typeof PublicKeyCredential !== "undefined",
      text: document.body.innerText,
    }));
    entry.activity = adb("shell", "dumpsys", "activity", "activities")
      .toString()
      .split("\n")
      .filter((line) => line.includes("topResumedActivity"));
    if (
      !entry.activity.some(
        (line) =>
          line.includes(
            values.baseline
              ? "org.chromium.chrome/"
              : "org.chromium.chrome/org.chromium.chrome.browser.customtabs.CustomTabActivity",
          ) ||
          (!values.baseline &&
            line.includes(
              "org.chromium.chrome/.browser.customtabs.CustomTabActivity",
            )),
      )
    ) {
      throw new Error(
        "Foreground activity does not prove the requested browser surface.",
      );
    }
    await writeFile(
      `${output}/${name}.png`,
      adb("exec-out", "screencap", "-p"),
    );
    entry.status =
      "public search or sign-in surface observed; screenshot requires inspection";
  } catch (error) {
    // error-policy:J1 The CLI records a failed real-device observation, then continues the independent website matrix.
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    // Only close the new target created by this test, preserving existing tabs.
    await createdPage?.close();
    await connection?.close();
  }
  report.results.push(entry);
  await writeFile(
    `${output}/report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`${name}: ${entry.status}`);
}
console.log(`Evidence: ${output}`);
