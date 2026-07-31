/**
 * Captures the built site at desktop and mobile sizes with an MP4 walkthrough
 * plus structured browser console and network logs for manual PR review.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = join(packageRoot, "evidence");
const videoRoot = join(evidenceRoot, ".video");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with ${code ?? "unknown"}`));
      }
    });
  });
}

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertPreviewRunning(server, state) {
  if (state.error) {
    throw new Error("[ElizaComputer] preview process could not start", {
      cause: state.error,
    });
  }
  if (server.exitCode !== null || server.signalCode !== null) {
    throw new Error(
      `[ElizaComputer] owned preview exited before evidence completed (code=${server.exitCode ?? "none"}, signal=${server.signalCode ?? "none"})`,
    );
  }
}

async function reserveLoopbackPort() {
  const listener = createServer();
  await new Promise((resolvePromise, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    listener.close();
    throw new Error("[ElizaComputer] could not reserve a loopback port");
  }
  await new Promise((resolvePromise, reject) => {
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolvePromise();
      }
    });
  });
  return address.port;
}

async function waitForServer(baseUrl, server, state, expectedBuildFingerprint) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    assertPreviewRunning(server, state);
    let response;
    try {
      response = await fetch(
        `${baseUrl}/skill-manifest.json?build=${expectedBuildFingerprint}`,
      );
    } catch {
      // error-policy:J5 Connection failures are observed by the owned-process check and bounded timeout.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `[ElizaComputer] owned preview returned ${response.status} for the build fingerprint`,
      );
    }
    const servedBuildFingerprint = hash(
      Buffer.from(await response.arrayBuffer()),
    );
    if (servedBuildFingerprint !== expectedBuildFingerprint) {
      throw new Error(
        "[ElizaComputer] preview served a build other than the one just produced",
      );
    }
    return;
  }
  throw new Error("[ElizaComputer] preview server did not become ready");
}

function waitForProcessExit(server, timeoutMs) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      server.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolvePromise(true);
    }
    server.once("exit", onExit);
  });
}

async function stopPreview(server) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  if (await waitForProcessExit(server, 3_000)) {
    return;
  }
  server.kill("SIGKILL");
  await waitForProcessExit(server, 3_000);
}

function digest(path) {
  return hash(readFileSync(path));
}

mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(videoRoot, { recursive: true });
await run("bun", ["run", "build"]);

const previewPort = await reserveLoopbackPort();
const baseUrl = `http://127.0.0.1:${previewPort}`;
const expectedBuildFingerprint = digest(
  join(packageRoot, "dist", "skill-manifest.json"),
);
const previewState = { error: undefined };
const server = spawn(
  "bun",
  [
    "--bun",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(previewPort),
    "--strictPort",
  ],
  {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit",
  },
);
server.once("error", (error) => {
  previewState.error = error;
});

try {
  await waitForServer(baseUrl, server, previewState, expectedBuildFingerprint);
  const browser = await chromium.launch();
  const log = {
    capturedAt: new Date().toISOString(),
    baseUrl,
    buildFingerprint: expectedBuildFingerprint,
    console: [],
    network: [],
    pageErrors: [],
    requestFailures: [],
  };

  async function capture(name, viewport, recordVideo = false) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      recordVideo: recordVideo
        ? { dir: videoRoot, size: { width: 1440, height: 900 } }
        : undefined,
      viewport,
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      log.console.push({
        page: name,
        type: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      log.pageErrors.push({
        page: name,
        message: error.message,
      });
    });
    page.on("response", (response) => {
      log.network.push({
        page: name,
        method: response.request().method(),
        status: response.status(),
        url: response.url(),
      });
    });
    page.on("requestfailed", (request) => {
      log.requestFailures.push({
        page: name,
        error: request.failure()?.errorText ?? "unknown",
        method: request.method(),
        url: request.url(),
      });
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assertPreviewRunning(server, previewState);
    await page.screenshot({
      fullPage: true,
      path: join(evidenceRoot, `${name}.jpg`),
      quality: 88,
      type: "jpeg",
    });

    let video;
    if (recordVideo) {
      video = page.video();
      await page.getByRole("tab", { name: "Codex" }).click();
      await page.locator("#work").scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: /^Pull requests/ }).click();
      await page.locator("#leaders").scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      await page.locator("#methodology").scrollIntoViewIfNeeded();
      await page.waitForTimeout(900);
      await page.locator("header").scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
    }
    await context.close();
    if (video) {
      await video.saveAs(join(evidenceRoot, "walkthrough.webm"));
    }
  }

  try {
    await capture("after-desktop", { width: 1440, height: 1000 }, true);
    await capture("after-mobile", { width: 320, height: 800 });
    assertPreviewRunning(server, previewState);
  } finally {
    await browser.close();
  }

  const webmPath = join(evidenceRoot, "walkthrough.webm");
  const mp4Path = join(evidenceRoot, "walkthrough.mp4");
  await run("ffmpeg", [
    "-y",
    "-i",
    webmPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ]);
  rmSync(webmPath);

  writeFileSync(
    join(evidenceRoot, "browser-log.json"),
    `${JSON.stringify(log, null, 2)}\n`,
  );

  const consoleErrors = log.console.filter((entry) => entry.type === "error");
  const pageErrors = log.pageErrors;
  const failedFirstPartyResponses = log.network.filter(
    (entry) => entry.url.startsWith(baseUrl) && entry.status >= 400,
  );
  const failedFirstPartyRequests = log.requestFailures.filter((entry) =>
    entry.url.startsWith(baseUrl),
  );
  const artifacts = [
    "after-desktop.jpg",
    "after-mobile.jpg",
    "walkthrough.mp4",
    "browser-log.json",
  ].map((name) => ({
    name,
    sha256: digest(join(evidenceRoot, name)),
  }));
  writeFileSync(
    join(evidenceRoot, "manifest.json"),
    `${JSON.stringify(
      {
        capturedAt: log.capturedAt,
        buildFingerprint: expectedBuildFingerprint,
        artifacts,
        validation: {
          consoleErrors: consoleErrors.length,
          failedFirstPartyRequests: failedFirstPartyRequests.length,
          failedFirstPartyResponses: failedFirstPartyResponses.length,
          pageErrors: pageErrors.length,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (
    consoleErrors.length > 0 ||
    pageErrors.length > 0 ||
    failedFirstPartyResponses.length > 0 ||
    failedFirstPartyRequests.length > 0
  ) {
    throw new Error(
      `[ElizaComputer] evidence captured browser errors: console=${consoleErrors.length}, page=${pageErrors.length}, responses=${failedFirstPartyResponses.length}, requests=${failedFirstPartyRequests.length}`,
    );
  }
  console.log(`[ElizaComputer] evidence written to ${evidenceRoot}`);
} finally {
  await stopPreview(server);
}
