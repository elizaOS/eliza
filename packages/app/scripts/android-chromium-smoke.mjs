#!/usr/bin/env node
/** Captures public website behavior on a real Android Chromium instance; reports observations without claiming authenticated compatibility. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const { values } = parseArgs({
  options: {
    serial: { type: "string" },
    port: { type: "string", default: "19224" },
    baseline: { type: "boolean", default: false },
    "browser-package": { type: "string", default: "org.chromium.chrome" },
  },
});
if (!values.serial || !/^\d+$/.test(values.port))
  throw new Error("Use --serial DEVICE [--port CDP_PORT] [--baseline].");
const browserPackage = values["browser-package"];
if (!["org.chromium.chrome", "ai.elizaos.chromium"].includes(browserPackage))
  throw new Error(
    "Browser package must match an upstream or owned Chromium build.",
  );
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
  browserPackage,
  authenticatedFlows: "not tested; user owns sign-in",
  fingerprint: adb("shell", "getprop", "ro.build.fingerprint")
    .toString()
    .trim(),
  results: [],
};

async function closeAndVerifyTarget(targetId) {
  const closed = await fetch(
    `http://127.0.0.1:${port}/json/close/${targetId}`,
    { signal: AbortSignal.timeout(5_000) },
  );
  if (!closed.ok)
    throw new Error(`Target close returned HTTP ${closed.status}.`);
  const remaining = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!remaining.ok) throw new Error("Cannot verify target cleanup.");
  if ((await remaining.json()).some((target) => target.id === targetId))
    throw new Error("Test target remains after the close request.");
}

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
        browserPackage,
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
    const deadline = Date.now() + 30_000;
    let target;
    while (!target && Date.now() < deadline) {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      target = targets.find((candidate) => {
        if (candidate.type !== "page" || previousTargets.has(candidate.id))
          return false;
        const host = new URL(candidate.url || "about:blank").hostname;
        return host === `${name}.com` || host.endsWith(`.${name}.com`);
      });
      if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!target)
      throw new Error("No new Chromium target matched the requested website.");
    createdPage = target.id;
    connection = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Page diagnostic connection timed out")),
        10_000,
      );
      connection.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      connection.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Page diagnostic connection failed"));
      };
    });
    let sequence = 0;
    const evaluate = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          connection.removeEventListener("message", receive);
          reject(new Error("Page observation timed out"));
        }, 10_000);
        function receive(event) {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          clearTimeout(timer);
          connection.removeEventListener("message", receive);
          if (message.error || message.result.exceptionDetails)
            reject(
              new Error(
                JSON.stringify(
                  message.error ?? message.result.exceptionDetails,
                ),
              ),
            );
          else resolve(message.result.result.value);
        }
        connection.addEventListener("message", receive);
        connection.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      });
    const readyExpression = `(() => {
      const site = ${JSON.stringify(name)};
      if (document.readyState === "loading" || !document.body) return false;
      if (site === "google") return document.querySelector('textarea[name="q"], input[name="q"]') !== null;
      const text = document.body.innerText;
      return site === "whatsapp"
        ? /scan.*(?:log in|QR)|link with phone number/i.test(text) && !text.includes("from a browser on your computer")
        : /log in|login|sign up|create.*account/i.test(text);
    })()`;
    let ready = false;
    const readyTimeoutMs = name === "whatsapp" ? 90_000 : 30_000;
    entry.readyTimeoutMs = readyTimeoutMs;
    const readyDeadline = Date.now() + readyTimeoutMs;
    while (!ready && Date.now() < readyDeadline) {
      ready = await evaluate(readyExpression);
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready)
      throw new Error("Public search or sign-in surface did not become ready.");
    // Android's native compositor may still show the splash after DOM readiness.
    // Wait for accessibility idle as well, then preserve its public-page tree.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    adb("shell", "uiautomator", "dump", "/sdcard/eliza-browser-public.xml");
    await writeFile(
      `${output}/${name}-accessibility.xml`,
      adb("shell", "cat", "/sdcard/eliza-browser-public.xml"),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    entry.observed = await evaluate(`JSON.parse(JSON.stringify(({
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      secureContext: isSecureContext,
      cookiesEnabled: navigator.cookieEnabled,
      serviceWorker: "serviceWorker" in navigator,
      passkeyApi: typeof PublicKeyCredential !== "undefined",
      text: document.body.innerText,
    })))`);
    entry.activity = adb("shell", "dumpsys", "activity", "activities")
      .toString()
      .split("\n")
      .filter((line) => line.includes("topResumedActivity"));
    if (
      !entry.activity.some(
        (line) =>
          line.includes(
            values.baseline
              ? `${browserPackage}/`
              : `${browserPackage}/org.chromium.chrome.browser.customtabs.CustomTabActivity`,
          ) ||
          (!values.baseline &&
            line.includes(
              `${browserPackage}/.browser.customtabs.CustomTabActivity`,
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
    try {
      await writeFile(
        `${output}/${name}-failed.png`,
        adb("exec-out", "screencap", "-p"),
      );
      entry.failureScreenshot = `${name}-failed.png`;
    } catch (captureError) {
      // error-policy:J1 Preserve the original failure and the diagnostic failure.
      entry.failureScreenshotError =
        captureError instanceof Error
          ? captureError.message
          : String(captureError);
    }
  } finally {
    // Only close the new target created by this test, preserving existing tabs.
    try {
      connection?.close();
      if (createdPage) {
        entry.cleanup = { targetId: createdPage, closed: false };
        await closeAndVerifyTarget(createdPage);
        entry.cleanup.closed = true;
      }
    } catch (cleanupError) {
      // error-policy:J1 Retain the site observation and continue the independent matrix.
      entry.observationStatus = entry.status;
      entry.status = "failed";
      entry.cleanupError =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      process.exitCode = 1;
    }
  }
  report.results.push(entry);
  await writeFile(
    `${output}/report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`${name}: ${entry.status}`);
}
console.log(`Evidence: ${output}`);
