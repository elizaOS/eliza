#!/usr/bin/env node
/**
 * Desktop browser evidence capture for the issue #15744 sol-dev flow.
 *
 * This runner records observable browser artifacts from an explicit URL. Web
 * Bluetooth pairing remains a manual checkpoint because browser automation
 * cannot prove a physical pendant connection.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ISSUE_EVIDENCE_DIR, REPO_ROOT } from "./lib/issue-evidence.mjs";
import {
  buildManifest,
  parseCliArgs,
  sanitizeToken,
  sha256File,
} from "./pendant-lightphone-e2e.mjs";

const ISSUE = "15744";
const PREFIX = `${ISSUE}-pendant-lightphone-desktop`;
const SECRET_KEY_PATTERN =
  /auth|token|secret|key|password|credential|cookie|sessionid|jwt|access|refresh|signature|sig|code/i;
const SELECTIVE_STORAGE_PATTERN = /transcript|session|conversation|pendant/i;
const MAX_CAPTURED_VALUE_CHARS = 4000;

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function createArtifactDir(output) {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error(
      `--output is required and must be a ${PREFIX}-* directory under .github/issue-evidence`,
    );
  }
  const dir = path.resolve(output);
  if (
    !assertInside(ISSUE_EVIDENCE_DIR, dir) ||
    !path.basename(dir).startsWith(`${PREFIX}-`)
  ) {
    throw new Error(
      `--output must be a ${PREFIX}-* directory under ${ISSUE_EVIDENCE_DIR}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function gitStamp() {
  const commands = {
    head: ["rev-parse", "HEAD"],
    branch: ["rev-parse", "--abbrev-ref", "HEAD"],
    status: ["status", "--short"],
    diffStat: ["diff", "--stat"],
  };
  const stamp = {};
  for (const [key, args] of Object.entries(commands)) {
    const result = spawnSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    stamp[key] =
      result.status === 0 ? result.stdout.trim() : result.stderr.trim();
  }
  return stamp;
}

function collectDownloadedArtifacts(artifactDir) {
  const files = [];
  for (const entry of readdirSync(artifactDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(artifactDir, entry.name);
    if (
      /transcript|session|download|export|artifact/i.test(entry.name) &&
      entry.name !== "artifact-manifest.json"
    ) {
      files.push({
        path: entry.name,
        size: statSync(full).size,
        sha256: sha256File(full),
      });
    }
  }
  return files;
}

function redactValue(key, value) {
  if (SECRET_KEY_PATTERN.test(String(key))) return "[REDACTED]";
  if (typeof value === "string")
    return value.slice(0, MAX_CAPTURED_VALUE_CHARS);
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryKey, entryValue),
      ]),
    );
  }
  return value;
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "data:") return "data:[REDACTED]";
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    if (parsed.hash) parsed.hash = "#[REDACTED]";
    return parsed.toString();
  } catch {
    return "[INVALID-URL-REDACTED]";
  }
}

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

function bodyForCapture(text, contentType) {
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(redactValue("body", JSON.parse(text)), null, 2);
    } catch {
      return text.slice(0, MAX_CAPTURED_VALUE_CHARS);
    }
  }
  return text.slice(0, MAX_CAPTURED_VALUE_CHARS);
}

function redactHarFile(harPath) {
  if (!existsSync(harPath)) return;
  const har = JSON.parse(readFileSync(harPath, "utf8"));
  for (const entry of har.log?.entries ?? []) {
    for (const side of ["request", "response"]) {
      const message = entry[side];
      if (!message) continue;
      if (Array.isArray(message.headers)) {
        message.headers = message.headers.map((header) => ({
          ...header,
          value: SECRET_KEY_PATTERN.test(header.name)
            ? "[REDACTED]"
            : header.value,
        }));
      }
      if (Array.isArray(message.cookies)) {
        message.cookies = message.cookies.map((cookie) => ({
          ...cookie,
          value: "[REDACTED]",
        }));
      }
    }
    if (entry.request?.url) {
      entry.request.url = redactUrl(entry.request.url);
    }
    if (Array.isArray(entry.request?.queryString)) {
      entry.request.queryString = entry.request.queryString.map(
        (parameter) => ({
          ...parameter,
          value: SECRET_KEY_PATTERN.test(parameter.name)
            ? "[REDACTED]"
            : parameter.value,
        }),
      );
    }
    if (entry.response?.redirectURL) {
      entry.response.redirectURL = redactUrl(entry.response.redirectURL);
    }
    if (entry.request?.postData) {
      entry.request.postData = {
        ...entry.request.postData,
        text: "[REDACTED]",
      };
    }
    if (entry.response?.content?.text) {
      entry.response.content.text = "[REDACTED]";
    }
  }
  writeFileSync(harPath, `${JSON.stringify(har, null, 2)}\n`, "utf8");
}

async function discoverBrowserArtifacts(
  page,
  selectors,
  endpoints,
  artifactDir,
) {
  const selectorArtifacts = [];
  for (const selector of selectors) {
    const values = await page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => ({
        selector,
        text: node.textContent,
        href: node instanceof HTMLAnchorElement ? node.href : null,
        download: node instanceof HTMLAnchorElement ? node.download : null,
      })),
    );
    selectorArtifacts.push(...values);
  }

  const storage = await page
    .evaluate(
      async ({ secretPatternSource, selectivePatternSource, maxChars }) => {
        const secretPattern = new RegExp(secretPatternSource, "i");
        const selectivePattern = new RegExp(selectivePatternSource, "i");
        const localStorageKeys = [];
        const selectiveLocalStorage = {};
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (!key) continue;
          localStorageKeys.push(key);
          if (selectivePattern.test(key)) {
            selectiveLocalStorage[key] = secretPattern.test(key)
              ? "[REDACTED]"
              : String(window.localStorage.getItem(key) ?? "").slice(
                  0,
                  maxChars,
                );
          }
        }
        const sessionStorageKeys = [];
        const selectiveSessionStorage = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const key = window.sessionStorage.key(i);
          if (!key) continue;
          sessionStorageKeys.push(key);
          if (selectivePattern.test(key)) {
            selectiveSessionStorage[key] = secretPattern.test(key)
              ? "[REDACTED]"
              : String(window.sessionStorage.getItem(key) ?? "").slice(
                  0,
                  maxChars,
                );
          }
        }
        const indexedDbNames =
          typeof indexedDB.databases === "function"
            ? await indexedDB.databases()
            : [];
        return {
          localStorageKeys,
          selectiveLocalStorage,
          sessionStorageKeys,
          selectiveSessionStorage,
          indexedDbNames,
        };
      },
      {
        secretPatternSource: SECRET_KEY_PATTERN.source,
        selectivePatternSource: SELECTIVE_STORAGE_PATTERN.source,
        maxChars: MAX_CAPTURED_VALUE_CHARS,
      },
    )
    .catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
      localStorageKeys: [],
      selectiveLocalStorage: {},
      sessionStorageKeys: [],
      selectiveSessionStorage: {},
      indexedDbNames: [],
    }));

  const endpointArtifacts = [];
  for (const [index, endpoint] of endpoints.entries()) {
    const response = await page.request.get(endpoint);
    const contentType = response.headers()["content-type"] ?? "";
    const bodyPath = `endpoint-${index}-${sanitizeToken(new URL(endpoint).pathname || "root")}.body.txt`;
    writeFileSync(
      path.join(artifactDir, bodyPath),
      bodyForCapture(await response.text(), contentType),
      "utf8",
    );
    endpointArtifacts.push({
      endpoint: redactUrl(endpoint),
      status: response.status(),
      headers: redactHeaders(response.headers()),
      contentType,
      bodyPath,
    });
  }
  return { selectorArtifacts, storage, endpointArtifacts };
}

async function captureCommand(flags) {
  const url = requireFlag(flags, "url");
  const artifactDir = createArtifactDir(requireFlag(flags, "output"));
  const durationSeconds = Number(flags.duration ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error("--duration must be a non-negative number of seconds");
  }
  const selectors = []
    .concat(flags.selector ?? [])
    .filter((value) => typeof value === "string");
  const endpoints = []
    .concat(flags.endpoint ?? [])
    .filter((value) => typeof value === "string");

  const consoleLogs = [];
  const pageErrors = [];
  const network = [];
  let browser;
  let context;
  let traceStarted = false;
  try {
    const playwright = await import("@playwright/test").catch((error) => {
      throw new Error(
        `@playwright/test is required for desktop capture: ${error.message}`,
      );
    });
    browser = await playwright.chromium.launch({
      headless: flags.headed !== true,
      executablePath:
        typeof flags.executable === "string" ? flags.executable : undefined,
    });
    const harPath = path.join(artifactDir, "network.har");
    context = await browser.newContext({
      recordHar: { path: harPath, mode: "full" },
      recordVideo: { dir: path.join(artifactDir, "video") },
      viewport: { width: 1440, height: 1000 },
    });
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    traceStarted = true;
    context.on("page", (page) => {
      page.on("console", (message) => {
        consoleLogs.push({
          type: message.type(),
          text: message.text(),
          location: message.location(),
        });
      });
      page.on("pageerror", (error) =>
        pageErrors.push(error.stack || error.message),
      );
      page.on("request", (request) => {
        network.push({
          event: "request",
          method: request.method(),
          url: redactUrl(request.url()),
          resourceType: request.resourceType(),
        });
      });
      page.on("response", (response) => {
        network.push({
          event: "response",
          status: response.status(),
          url: redactUrl(response.url()),
          method: response.request().method(),
        });
      });
      page.on("requestfailed", (request) => {
        network.push({
          event: "requestfailed",
          method: request.method(),
          url: redactUrl(request.url()),
          failure: request.failure()?.errorText ?? "unknown",
        });
      });
    });

    const page = await context.newPage();
    const downloads = [];
    const downloadSaves = [];
    page.on("download", (download) => {
      const suggested = sanitizeToken(
        download.suggestedFilename() || "download",
      );
      const out = path.join(artifactDir, `download-${Date.now()}-${suggested}`);
      downloadSaves.push(
        download.saveAs(out).then(() => {
          downloads.push(out);
        }),
      );
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    if (durationSeconds > 0) {
      await page.waitForTimeout(durationSeconds * 1000);
    }
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch((error) => {
        network.push({
          event: "networkidle-timeout",
          message: error.message,
        });
      });
    await page.screenshot({
      path: path.join(artifactDir, "desktop-fullpage.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(artifactDir, "mobile-fullpage.png"),
      fullPage: true,
    });
    const discovered = await discoverBrowserArtifacts(
      page,
      selectors,
      endpoints,
      artifactDir,
    );
    writeJson(
      path.join(artifactDir, "browser-discovered-artifacts.json"),
      discovered,
    );
    writeJson(path.join(artifactDir, "console.json"), consoleLogs);
    writeJson(path.join(artifactDir, "page-errors.json"), pageErrors);
    writeJson(path.join(artifactDir, "network-events.json"), network);
    writeJson(path.join(artifactDir, "git-build-stamp.json"), {
      issue: `https://github.com/elizaOS/eliza/issues/${ISSUE}`,
      url: redactUrl(url),
      explicitUrl: redactUrl(url),
      capturedAt: new Date().toISOString(),
      durationSeconds,
      git: gitStamp(),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? null,
        ELIZA_UI_PORT: process.env.ELIZA_UI_PORT ?? null,
        ELIZA_API_PORT: process.env.ELIZA_API_PORT ?? null,
      },
    });
    writeJson(path.join(artifactDir, "manual-web-bluetooth-checkpoint.json"), {
      status: "unverified",
      proof: "physical",
      reason: [
        "Web Bluetooth chooser/pairing requires a human and a real pendant.",
        "This Playwright capture does not fake or claim physical pairing.",
      ].join(" "),
      requiredArtifacts: [
        "screen recording showing chooser/device selection",
        "browser console/network logs from the same run",
        "LP3 physical capture manifest when pairing is performed through the phone",
      ],
    });
    await Promise.all(downloadSaves);
    writeJson(path.join(artifactDir, "downloads.json"), {
      downloads,
      discoveredFiles: collectDownloadedArtifacts(artifactDir),
    });
  } catch (error) {
    writeJson(path.join(artifactDir, "failure.json"), {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
      capturedAt: new Date().toISOString(),
      url: redactUrl(url),
    });
    throw error;
  } finally {
    if (context && traceStarted) {
      await context.tracing
        .stop({ path: path.join(artifactDir, "trace.zip") })
        .catch((error) =>
          writeJson(path.join(artifactDir, "trace-stop-failure.json"), {
            message: error.message,
          }),
        );
    }
    if (context) {
      await context.close().catch((error) =>
        writeJson(path.join(artifactDir, "context-close-failure.json"), {
          message: error.message,
        }),
      );
    }
    if (browser) {
      await browser.close().catch((error) =>
        writeJson(path.join(artifactDir, "browser-close-failure.json"), {
          message: error.message,
        }),
      );
    }
    try {
      redactHarFile(path.join(artifactDir, "network.har"));
    } catch (error) {
      writeJson(path.join(artifactDir, "har-redaction-failure.json"), {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    buildManifest(artifactDir);
  }
  console.log(`Desktop evidence captured: ${artifactDir}`);
}

function usage() {
  console.log(`Usage:
  node scripts/pendant-lightphone-desktop-evidence.mjs capture \\
    --url <sol-dev-url> --output <dir> [--selector <css>] [--endpoint <url>] [--executable <chromium>]

--output must be a ${PREFIX}-* directory under .github/issue-evidence.
Use --duration <seconds> with --headed to interact with Web Bluetooth before final capture.
The Web Bluetooth picker remains a manual checkpoint; this script records browser evidence only.`);
}

async function main(argv = process.argv.slice(2)) {
  const { subcommand, flags } = parseCliArgs(argv);
  if (subcommand === "capture") return captureCommand(flags);
  if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    return usage();
  }
  throw new Error(`unknown subcommand: ${subcommand}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[pendant-lightphone-desktop-evidence] ${error.message}`);
    process.exit(1);
  });
}
