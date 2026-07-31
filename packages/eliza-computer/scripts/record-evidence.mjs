/**
 * Captures local or production evidence from an already identified site build.
 * Production mode never builds: it proves the deployed apex serves the exact
 * local dist before recording pixels, traffic, DNS, TLS, and redirect state.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { connect as connectTls } from "node:tls";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  beginEvidenceTransaction,
  validateEvidenceBundle,
} from "./evidence-bundle.mjs";
import {
  assertCommittedBuildManifest,
  assertDnsAddresses,
  assertHttpsRedirect,
  assertImmutableAssetCache,
  assertLiveLedgerReady,
  assertSecurityHeaders,
  assertTlsSession,
  PRODUCTION_HOSTNAME,
  PRODUCTION_ORIGIN,
  parseEvidenceMode,
  REMOTE_ARTIFACT_PATHS,
  shouldBuildForEvidence,
  verifyRemoteArtifacts,
} from "./evidence-contract.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const distRoot = join(packageRoot, "dist");
const finalEvidenceRoot = join(packageRoot, "evidence");
const mode = parseEvidenceMode(process.argv.slice(2));

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

function digest(path) {
  return hash(readFileSync(path));
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("[ElizaComputer] could not identify the evidence revision");
  }
  const revision = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new TypeError(
      "[ElizaComputer] evidence revision is not a full commit SHA",
    );
  }
  return revision;
}

function readDistArtifacts() {
  return REMOTE_ARTIFACT_PATHS.map((path) => {
    const localPath = join(distRoot, ...path.split("/"));
    let contents;
    try {
      contents = readFileSync(localPath);
    } catch (error) {
      // error-policy:J2 evidence capture reports the exact missing build path.
      throw new Error(
        `[ElizaComputer] dist is incomplete: ${path} is not readable`,
        { cause: error },
      );
    }
    if (contents.length === 0) {
      throw new Error(`[ElizaComputer] dist artifact is empty: ${path}`);
    }
    return { contents, localPath, path };
  });
}

function findArtifact(artifacts, path) {
  const artifact = artifacts.find((candidate) => candidate.path === path);
  if (!artifact) {
    throw new TypeError(`[ElizaComputer] dist omitted required ${path}`);
  }
  return artifact;
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

async function waitForServer(baseUrl, server, state, expectedFingerprint) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    assertPreviewRunning(server, state);
    let response;
    try {
      response = await fetch(
        `${baseUrl}/skill-manifest.json?build=${expectedFingerprint}`,
        {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
          signal: AbortSignal.timeout(5_000),
        },
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
    const servedFingerprint = hash(Buffer.from(await response.arrayBuffer()));
    if (servedFingerprint !== expectedFingerprint) {
      throw new Error(
        "[ElizaComputer] preview served a build other than the selected dist",
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
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  if (await waitForProcessExit(server, 3_000)) {
    return;
  }
  server.kill("SIGKILL");
  await waitForProcessExit(server, 3_000);
}

async function inspectTls() {
  return new Promise((resolvePromise, reject) => {
    const socket = connectTls({
      host: PRODUCTION_HOSTNAME,
      port: 443,
      rejectUnauthorized: true,
      servername: PRODUCTION_HOSTNAME,
    });
    socket.setTimeout(10_000);
    socket.once("timeout", () => {
      socket.destroy(
        new Error("[ElizaComputer] production TLS handshake timed out"),
      );
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      const session = assertTlsSession({
        authorizationError: socket.authorizationError,
        authorized: socket.authorized,
        cipher: socket.getCipher()?.name,
        issuer: certificate.issuer?.CN,
        protocol: socket.getProtocol(),
        subject: certificate.subject?.CN,
        subjectAltName: certificate.subjectaltname,
        validFrom: certificate.valid_from,
        validTo: certificate.valid_to,
      });
      socket.end();
      resolvePromise(session);
    });
  });
}

function hashedAssetPath(indexHtml) {
  const match = indexHtml.match(/(?:href|src)="(\/assets\/[^"?]+)"/);
  if (!match) {
    throw new TypeError(
      "[ElizaComputer] built index omitted a hashed /assets reference",
    );
  }
  return match[1];
}

async function inspectProductionNetwork(cacheKey, assetPath) {
  const addresses = assertDnsAddresses(
    await lookup(PRODUCTION_HOSTNAME, { all: true, verbatim: true }),
  );
  const tls = await inspectTls();
  const httpUrl = new URL(`http://${PRODUCTION_HOSTNAME}/`);
  httpUrl.searchParams.set("verify", cacheKey);
  const redirectResponse = await fetch(httpUrl, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const redirect = assertHttpsRedirect(
    redirectResponse.status,
    redirectResponse.headers.get("location"),
  );
  const httpsUrl = new URL("/", PRODUCTION_ORIGIN);
  httpsUrl.searchParams.set("verify", cacheKey);
  const httpsResponse = await fetch(httpsUrl, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!httpsResponse.ok) {
    throw new Error(
      `[ElizaComputer] production apex returned HTTP ${httpsResponse.status}`,
    );
  }
  if (new URL(httpsResponse.url).origin !== PRODUCTION_ORIGIN) {
    throw new Error(
      `[ElizaComputer] production HTTPS request left ${PRODUCTION_ORIGIN}`,
    );
  }
  const securityHeaders = assertSecurityHeaders(httpsResponse.headers);
  await httpsResponse.arrayBuffer();
  const assetUrl = new URL(assetPath, PRODUCTION_ORIGIN);
  assetUrl.searchParams.set("verify", cacheKey);
  const assetResponse = await fetch(assetUrl, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!assetResponse.ok) {
    throw new Error(
      `[ElizaComputer] production asset returned HTTP ${assetResponse.status}`,
    );
  }
  const assetCacheControl = assertImmutableAssetCache(assetResponse.headers);
  await assetResponse.arrayBuffer();
  return {
    asset: {
      cacheControl: assetCacheControl,
      status: assetResponse.status,
      url: assetResponse.url,
    },
    dns: { addresses, hostname: PRODUCTION_HOSTNAME },
    https: { status: httpsResponse.status, url: httpsResponse.url },
    redirect,
    securityHeaders,
    tls,
  };
}

function firstParty(url, expectedOrigin) {
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    // error-policy:J3 malformed browser telemetry is an explicit non-first-party value.
    return false;
  }
}

if (shouldBuildForEvidence(mode)) {
  await run("bun", ["run", "build"]);
}

const artifacts = readDistArtifacts();
const indexArtifact = findArtifact(artifacts, "index.html");
const manifestArtifact = findArtifact(artifacts, "skill-manifest.json");
const leaderboardArtifact = findArtifact(artifacts, "data/leaderboard.json");
const buildFingerprint = hash(manifestArtifact.contents);
const ledger = assertLiveLedgerReady(leaderboardArtifact.contents);
const revision = gitHead();
const cacheKey = `${revision}-${Date.now()}`;

let baseUrl;
let previewServer;
let previewState;
let verification;

if (mode === "production") {
  const manifest = assertCommittedBuildManifest(
    manifestArtifact.contents,
    revision,
  );
  const remoteArtifacts = await verifyRemoteArtifacts({
    artifacts,
    cacheKey,
  });
  const network = await inspectProductionNetwork(
    cacheKey,
    hashedAssetPath(indexArtifact.contents.toString("utf8")),
  );
  baseUrl = PRODUCTION_ORIGIN;
  verification = {
    schemaVersion: "1",
    capturedAt: new Date().toISOString(),
    mode,
    origin: PRODUCTION_ORIGIN,
    buildFingerprint,
    ledger,
    manifest,
    network,
    remoteArtifacts,
    revision,
  };
} else {
  const previewPort = await reserveLoopbackPort();
  baseUrl = `http://127.0.0.1:${previewPort}`;
  previewState = { error: undefined };
  previewServer = spawn(
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
  previewServer.once("error", (error) => {
    previewState.error = error;
  });
  try {
    await waitForServer(baseUrl, previewServer, previewState, buildFingerprint);
  } catch (error) {
    // error-policy:J6 a failed local preview is terminated before its startup error is rethrown.
    await stopPreview(previewServer);
    throw error;
  }
  verification = {
    schemaVersion: "1",
    capturedAt: new Date().toISOString(),
    mode,
    origin: baseUrl,
    buildFingerprint,
    ledger,
    revision,
  };
}

let evidenceTransaction;
try {
  evidenceTransaction = beginEvidenceTransaction(finalEvidenceRoot);
} catch (error) {
  // error-policy:J6 a local preview is terminated if evidence staging cannot begin.
  await stopPreview(previewServer);
  throw error;
}
const evidenceRoot = evidenceTransaction.stagingRoot;
const videoRoot = join(evidenceRoot, ".video");
mkdirSync(videoRoot, { recursive: true });

try {
  writeFileSync(
    join(evidenceRoot, "site-verification.json"),
    `${JSON.stringify(verification, null, 2)}\n`,
  );

  const browser = await chromium.launch();
  const log = {
    capturedAt: verification.capturedAt,
    baseUrl,
    buildFingerprint,
    mode,
    console: [],
    network: [],
    pageErrors: [],
    requestFailures: [],
  };
  const expectedOrigin = new URL(baseUrl).origin;

  async function capture(name, viewport, recordVideo = false) {
    const context = await browser.newContext({
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
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

    await page.goto(`${baseUrl}/?evidence=${cacheKey}`, {
      waitUntil: "networkidle",
    });
    await page
      .getByText("Latest GitHub snapshot", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("#leaders table").waitFor({ state: "visible" });
    if (previewServer && previewState) {
      assertPreviewRunning(previewServer, previewState);
    }
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
    if (previewServer && previewState) {
      assertPreviewRunning(previewServer, previewState);
    }
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
  rmSync(videoRoot, { force: true, recursive: true });

  writeFileSync(
    join(evidenceRoot, "browser-log.json"),
    `${JSON.stringify(log, null, 2)}\n`,
  );

  const consoleErrors = log.console.filter((entry) => entry.type === "error");
  const pageErrors = log.pageErrors;
  const failedFirstPartyResponses = log.network.filter(
    (entry) => firstParty(entry.url, expectedOrigin) && entry.status >= 400,
  );
  const failedFirstPartyRequests = log.requestFailures.filter((entry) =>
    firstParty(entry.url, expectedOrigin),
  );
  const artifactNames = [
    "after-desktop.jpg",
    "after-mobile.jpg",
    "walkthrough.mp4",
    "browser-log.json",
    "site-verification.json",
  ];
  const recordedArtifacts = artifactNames.map((name) => ({
    name,
    sha256: digest(join(evidenceRoot, name)),
  }));
  writeFileSync(
    join(evidenceRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1",
        capturedAt: log.capturedAt,
        buildFingerprint,
        mode,
        artifacts: recordedArtifacts,
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
  validateEvidenceBundle(evidenceRoot, { buildFingerprint, mode });
  evidenceTransaction.publish();
  console.log(
    `[ElizaComputer] ${mode} evidence written to ${finalEvidenceRoot}`,
  );
} finally {
  await stopPreview(previewServer);
  evidenceTransaction.abort();
}
