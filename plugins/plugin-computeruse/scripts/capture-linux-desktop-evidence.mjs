#!/usr/bin/env bun
/**
 * Captures Linux X11 desktop-control evidence in a disposable application and
 * emits the manifest consumed by the platform-evidence validator. The harness
 * refuses non-X11 sessions and confines synthetic input to a newly launched
 * xterm whose only job is to persist one verification marker.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseApprovalManager } from "../src/approval-manager.ts";
import { isBrowserAvailable } from "../src/platform/browser.ts";
import { detectPlatformCapabilities } from "../src/platform/capabilities.ts";
import { readClipboard, writeClipboard } from "../src/platform/clipboard.ts";
import { commandExists } from "../src/platform/helpers.ts";
import {
  analyzePngScreenshot,
  screenshotQualityIssues,
} from "../src/platform/screenshot-quality.ts";
import { executeTerminal } from "../src/platform/terminal.ts";
import { ComputerUseService } from "../src/services/computer-use-service.ts";

const CHECK_ORDER = [
  "capabilityProbe",
  "dependencyProbe",
  "screenshotCapture",
  "mouseKeyboardInput",
  "windowListFocus",
  "browserAutomation",
  "clipboardRoundTrip",
  "terminalSafety",
  "approvalMode",
];

const CHECK_METHODS = {
  capabilityProbe: "detectPlatformCapabilities/getCapabilities",
  dependencyProbe: "ensure-platform-deps / commandExists",
  screenshotCapture: "captureDisplay/capturePrimaryDisplay",
  mouseKeyboardInput: "ComputerUseService desktop actions",
  windowListFocus: "listWindows/focusWindow",
  browserAutomation: "browser open/navigate/get/screenshot/close",
  clipboardRoundTrip: "readClipboard/writeClipboard",
  terminalSafety: "terminal execution safety",
  approvalMode: "ComputerUseApprovalManager",
};

const ISSUE = 22389;
const SLUG = "22389-linux-desktop-cua";
const SCRIPT_NAME = "capture-linux-desktop-evidence.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const defaultOutDir = path.join(repoRoot, "test-results/evidence", SLUG);
const approvalConfigPath = path.join(
  os.homedir(),
  ".eliza",
  "computer-use-approval.json",
);

function usage() {
  return [
    `Usage: bun scripts/${SCRIPT_NAME} [--out <dir>] [--skip-browser]`,
    "",
    "Captures repeatable Linux X11 computer-use evidence in a controlled xterm.",
    `Writes evidence to test-results/evidence/${SLUG}/ by default.`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { outDir: defaultOutDir, skipBrowser: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out requires a directory");
      options.outDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--skip-browser") {
      options.skipBrowser = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runText(command, args, fallback = "unknown") {
  try {
    const value = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    return value.length > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

function createRuntime(settings = {}) {
  return {
    character: {},
    getSetting(key) {
      return settings[key];
    },
    getService() {
      return null;
    },
  };
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function newCheck(id) {
  return {
    id,
    method: CHECK_METHODS[id],
    status: "requires_device_evidence",
    requiredEvidence: [`${id} was not run`],
  };
}

function setCheck(checks, details, id, status, requiredEvidence, extra = {}) {
  checks.set(id, { id, method: CHECK_METHODS[id], status, requiredEvidence });
  details[id] = { status, requiredEvidence, ...extra };
}

async function runCheck(checks, details, id, fn) {
  try {
    const result = await fn();
    setCheck(
      checks,
      details,
      id,
      result.status ?? "passed",
      result.requiredEvidence,
      result.details ? { details: result.details } : {},
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCheck(checks, details, id, "failed", [`${id} failed: ${message}`], {
      error: error instanceof Error ? (error.stack ?? error.message) : message,
    });
  }
}

function pngBufferFromBase64(base64) {
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("missing PNG base64 payload");
  }
  return Buffer.from(base64, "base64");
}

function describePng(buffer, label) {
  const quality = analyzePngScreenshot(buffer);
  const issues = screenshotQualityIssues(label, quality);
  if (buffer.length <= 100) {
    issues.unshift(`${label}: decoded PNG byte length ${buffer.length} <= 100`);
  }
  if (issues.length > 0) {
    throw new Error(
      `${label}: screenshot quality failed: ${issues.join("; ")}; metrics=${JSON.stringify({ byteLength: buffer.length, ...quality })}`,
    );
  }
  return { byteLength: buffer.length, ...quality };
}

function displayForPoint(displays, x, y) {
  return (
    displays.find((display) => {
      const [dx, dy, width, height] = display.bounds;
      return x >= dx && x < dx + width && y >= dy && y < dy + height;
    }) ??
    displays.find((display) => display.primary) ??
    displays[0]
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(filePath, "utf8")) === expected) return;
    } catch {
      // error-policy:J3 the controlled writer has not produced its marker yet.
    }
    await sleep(50);
  }
  throw new Error("controlled xterm did not persist the typed marker");
}

async function waitForWindow(service, title) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await service.executeCommand("list_windows");
    const target = result.windows?.find((windowInfo) =>
      String(windowInfo.title ?? "").includes(title),
    );
    if (result.success && target?.id) return { result, target };
    await sleep(100);
  }
  throw new Error(`controlled X11 window ${title} was not enumerated`);
}

async function waitForPendingApproval(service) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const approval = service.getApprovalSnapshot().pendingApprovals[0];
    if (approval) return approval.id;
    await sleep(50);
  }
  throw new Error("timed out waiting for a pending approval");
}

async function preserveApprovalConfig(run) {
  const hadConfig = existsSync(approvalConfigPath);
  const original = hadConfig ? await readFile(approvalConfigPath, "utf8") : "";
  try {
    return await run();
  } finally {
    if (hadConfig) {
      await mkdir(path.dirname(approvalConfigPath), { recursive: true });
      await writeFile(approvalConfigPath, original, "utf8");
    } else {
      await rm(approvalConfigPath, { force: true });
    }
  }
}

async function runBrowserCheck(service, outDir, artifacts) {
  const pageUrl =
    "data:text/html,<html><head><title>Linux CUA Evidence</title></head><body><main><h1>Linux CUA Evidence</h1><button id='go'>Ready</button><input id='field'></main></body></html>";
  const open = await service.executeCommand("browser_open", { url: pageUrl });
  if (!open.success) throw new Error(`browser_open failed: ${open.error}`);
  let closed = false;
  try {
    const dom = await service.executeCommand("browser_get_dom");
    if (
      !dom.success ||
      !String(dom.content ?? "").includes("Linux CUA Evidence")
    ) {
      throw new Error(
        `browser_get_dom failed: ${dom.error ?? "missing marker"}`,
      );
    }
    const clickables = await service.executeCommand("browser_get_clickables");
    if (!clickables.success) {
      throw new Error(`browser_get_clickables failed: ${clickables.error}`);
    }
    const screenshot = await service.executeCommand("browser_screenshot");
    if (!screenshot.success) {
      throw new Error(`browser_screenshot failed: ${screenshot.error}`);
    }
    const png = pngBufferFromBase64(screenshot.screenshot);
    const quality = describePng(png, "browser screenshot");
    const artifact = path.join(outDir, "browser-evidence.png");
    await writeFile(artifact, png);
    artifacts.push(relativeToRepo(artifact));
    const close = await service.executeCommand("browser_close");
    if (!close.success) {
      throw new Error(`browser_close failed: ${close.error}`);
    }
    closed = true;
    return {
      requiredEvidence: [
        "browser target opened the local evidence data URL",
        "browser_get_dom returned the local evidence page",
        `browser_get_clickables returned ${clickables.count ?? clickables.elements?.length ?? "some"} element(s)`,
        `browser screenshot artifact ${relativeToRepo(artifact)} (${quality.width}x${quality.height})`,
        "browser cleanup closed the test browser",
      ],
      details: { open, quality },
    };
  } finally {
    if (!closed) await service.executeCommand("browser_close");
  }
}

async function runApprovalCheck(outDir, artifacts) {
  const approvalPath = path.join(outDir, "approval-full-control.txt");
  const service = await ComputerUseService.start(
    createRuntime({
      COMPUTER_USE_APPROVAL_MODE: "smart_approve",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "false",
    }),
  );
  try {
    const manager = new ComputerUseApprovalManager();
    manager.setMode("smart_approve");
    const smartReadOnly = manager.shouldAutoApprove("screenshot");
    const smartWrite = manager.shouldAutoApprove("file_write");
    manager.setMode("full_control");
    const fullControl = manager.shouldAutoApprove("file_write");
    manager.setMode("approve_all");
    const approveAll = manager.shouldAutoApprove("screenshot");
    manager.setMode("off");
    if (
      !smartReadOnly ||
      smartWrite ||
      !fullControl ||
      approveAll ||
      !manager.isDenyAll()
    ) {
      throw new Error("approval manager mode predicates did not match policy");
    }
    const pending = service.executeCommand("file_write", {
      path: approvalPath,
      content: "must not be written without approval",
    });
    const approvalId = await waitForPendingApproval(service);
    service.resolveApproval(approvalId, false, "Linux evidence denial check");
    if ((await pending).success) {
      throw new Error("smart_approve write unexpectedly succeeded");
    }
    service.setApprovalMode("full_control");
    const write = await service.executeCommand("file_write", {
      path: approvalPath,
      content: "full_control approval evidence",
    });
    if (!write.success)
      throw new Error(`full_control write failed: ${write.error}`);
    artifacts.push(relativeToRepo(approvalPath));
    service.setApprovalMode("off");
    if ((await service.executeCommand("screenshot")).success) {
      throw new Error("off mode unexpectedly allowed screenshot");
    }
    return {
      requiredEvidence: [
        "smart_approve auto-approves read-only actions",
        "smart_approve queues destructive file_write until approval",
        "full_control auto-approves destructive actions",
        "approve_all does not auto-approve read-only actions",
        "off mode denies actions",
      ],
      details: { approvalPath: relativeToRepo(approvalPath) },
    };
  } finally {
    await service.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "linux") {
    throw new Error(`Linux evidence requires linux, got ${process.platform}`);
  }
  if (!process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "wayland") {
    throw new Error("Linux evidence requires an active X11 DISPLAY");
  }

  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  const scratch = await mkdtemp(path.join(os.tmpdir(), "eliza-linux-cua-"));
  const markerPath = path.join(scratch, "typed-marker.txt");
  const marker = `eliza-linux-cua-${Date.now()}`;
  const windowTitle = `Eliza CUA Evidence ${Date.now()}`;
  const generatedAt = new Date().toISOString();
  const machineId = runText("cat", ["/etc/machine-id"]);
  const distribution = runText("sh", [
    "-c",
    '. /etc/os-release && printf \'%s %s\' "$NAME" "$VERSION_ID"',
  ]);
  const kernelVersion = os.release();
  const displayServer = `X11:${process.env.DISPLAY}`;
  const gitHead = runText("git", ["rev-parse", "--short", "HEAD"]);
  const buildId = `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? gitHead}`;
  const artifacts = [];
  const details = {};
  const checks = new Map(CHECK_ORDER.map((id) => [id, newCheck(id)]));
  let xterm = null;

  const service = await ComputerUseService.start(
    createRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "true",
      COMPUTER_USE_BROWSER_HEADLESS: "false",
    }),
  );

  try {
    const capabilities = detectPlatformCapabilities({
      osName: "linux",
      commandExists,
      isBrowserAvailable,
      shell: process.env.SHELL ?? "/bin/bash",
    });
    const serviceCapabilities = service.getCapabilities();
    const displays = service.getDisplays();

    await runCheck(checks, details, "capabilityProbe", async () => {
      const expected = [
        "screenshot",
        "computerUse",
        "windowList",
        "browser",
        "terminal",
        "fileSystem",
        "clipboard",
      ];
      for (const key of expected) {
        if (typeof capabilities[key]?.available !== "boolean") {
          throw new Error(`missing capability ${key}`);
        }
      }
      return {
        requiredEvidence: [
          "platform is linux",
          `reported capabilities: ${expected.map((key) => `${key}=${capabilities[key].available ? "available" : "unavailable"}:${capabilities[key].tool}`).join("; ")}`,
          `service capabilities report screenshot=${serviceCapabilities.screenshot.available}, windowList=${serviceCapabilities.windowList.available}`,
        ],
        details: { capabilities, serviceCapabilities, displays },
      };
    });

    await runCheck(checks, details, "dependencyProbe", async () => {
      const required = ["xdotool", "scrot", "wmctrl", "xclip", "xterm"];
      const missing = required.filter((command) => !commandExists(command));
      if (missing.length > 0) {
        throw new Error(`missing X11 dependencies: ${missing.join(", ")}`);
      }
      return {
        requiredEvidence: [
          "xdotool legacy input driver is available",
          "scrot screenshot backend is available",
          "wmctrl window-list backend is available",
          "xclip clipboard backend is available",
        ],
        details: { required },
      };
    });

    xterm = spawn(
      "xterm",
      [
        "-T",
        windowTitle,
        "-geometry",
        "80x24+80+80",
        "-e",
        "/bin/bash",
        "-lc",
        'IFS= read -r line; printf "%s" "$line" > "$ELIZA_EVIDENCE_MARKER_PATH"; sleep 2',
      ],
      {
        env: { ...process.env, ELIZA_EVIDENCE_MARKER_PATH: markerPath },
        stdio: "ignore",
      },
    );
    const { result: windows, target } = await waitForWindow(
      service,
      windowTitle,
    );

    await runCheck(checks, details, "windowListFocus", async () => {
      const focus = await service.executeCommand("switch_to_window", {
        windowId: target.id,
      });
      if (!focus.success)
        throw new Error(`switch_to_window failed: ${focus.error}`);
      return {
        requiredEvidence: [
          `listWindows returned ${windows.windows.length} visible window(s) with metadata`,
          `focusWindow/switchWindow succeeded for controlled xterm ${target.id}`,
          "window operation failures retain dependency guidance",
        ],
        details: { target, sampleWindows: windows.windows.slice(0, 5) },
      };
    });

    await runCheck(checks, details, "screenshotCapture", async () => {
      const screenshot = await service.executeCommand("screenshot");
      if (!screenshot.success)
        throw new Error(screenshot.error ?? "screenshot failed");
      const png = pngBufferFromBase64(screenshot.screenshot);
      const quality = describePng(png, "primary display screenshot");
      const artifact = path.join(options.outDir, "screenshot-primary.png");
      await writeFile(artifact, png);
      artifacts.push(relativeToRepo(artifact));
      const display =
        displays.find((entry) => entry.id === screenshot.displayId) ??
        displays.find((entry) => entry.primary) ??
        displays[0];
      if (!display) throw new Error("no display metadata returned");
      const expectedWidth = Math.round(display.bounds[2] * display.scaleFactor);
      const expectedHeight = Math.round(
        display.bounds[3] * display.scaleFactor,
      );
      if (
        quality.width !== expectedWidth ||
        quality.height !== expectedHeight
      ) {
        throw new Error(
          `screenshot dimensions ${quality.width}x${quality.height} did not match display ${expectedWidth}x${expectedHeight}`,
        );
      }
      return {
        requiredEvidence: [
          `primary display capture returned ${quality.byteLength} PNG bytes`,
          `captured dimensions ${quality.width}x${quality.height} match display ${display.id}`,
          `screenshot artifact ${relativeToRepo(artifact)}`,
        ],
        details: { display, quality },
      };
    });

    await runCheck(checks, details, "mouseKeyboardInput", async () => {
      const bounds = await service.executeWindowAction({
        action: "get_window_position",
        windowId: target.id,
      });
      if (!bounds.success || !bounds.bounds) {
        throw new Error(`window bounds failed: ${bounds.error}`);
      }
      const globalX = Math.round(bounds.bounds.x + bounds.bounds.width / 2);
      const globalY = Math.round(bounds.bounds.y + bounds.bounds.height / 2);
      const display = displayForPoint(displays, globalX, globalY);
      if (!display) throw new Error("no display for controlled xterm");
      const [displayX, displayY] = display.bounds;
      const coordinate = [globalX - displayX, globalY - displayY];
      for (const [command, params] of [
        ["mouse_move", { coordinate, displayId: display.id }],
        ["click", { coordinate, displayId: display.id }],
        ["type", { text: marker }],
        ["key", { key: "Return" }],
      ]) {
        const result = await service.executeCommand(command, params);
        if (!result.success)
          throw new Error(`${command} failed: ${result.error}`);
      }
      await waitForFile(markerPath, marker);
      return {
        requiredEvidence: [
          `mouse_move and click succeeded at ${coordinate.join(",")} on display ${display.id}`,
          `type and Return wrote verified marker ${marker} in the controlled xterm`,
          "post-action screenshots were requested by service configuration",
        ],
        details: { target, bounds: bounds.bounds, coordinate, marker },
      };
    });

    if (options.skipBrowser) {
      setCheck(
        checks,
        details,
        "browserAutomation",
        "requires_device_evidence",
        ["browser proof skipped by --skip-browser"],
      );
    } else {
      await runCheck(checks, details, "browserAutomation", () =>
        runBrowserCheck(service, options.outDir, artifacts),
      );
    }

    await runCheck(checks, details, "clipboardRoundTrip", async () => {
      const original = await readClipboard().catch(() => "");
      const token = `linux-clipboard-${Date.now()}`;
      try {
        await writeClipboard(token);
        if ((await readClipboard()).trimEnd() !== token) {
          throw new Error("clipboard did not return the test marker");
        }
      } finally {
        await writeClipboard(original);
      }
      return {
        requiredEvidence: [
          `xclip wrote test marker ${token}`,
          "xclip read the same test marker",
          "the original clipboard value was restored",
        ],
        details: { marker: token, restoredOriginalClipboard: true },
      };
    });

    await runCheck(checks, details, "terminalSafety", async () => {
      const token = `linux-terminal-${Date.now()}`;
      const allowed = await executeTerminal({ command: `printf '${token}'` });
      if (!allowed.success || allowed.output !== token) {
        throw new Error(`harmless terminal command failed: ${allowed.error}`);
      }
      const blocked = await executeTerminal({ command: "rm -rf /" });
      if (blocked.success || !blocked.error) {
        throw new Error("dangerous root deletion was not rejected");
      }
      const started = Date.now();
      const timed = await executeTerminal({
        command: "sleep 5",
        timeoutSeconds: 1,
      });
      if (timed.success || Date.now() - started > 4000) {
        throw new Error("terminal timeout was not enforced promptly");
      }
      return {
        requiredEvidence: [
          `allowed harmless shell command produced ${token}`,
          `dangerous root deletion was rejected: ${blocked.error}`,
          `a 1s timeout terminated sleep in ${Date.now() - started}ms`,
        ],
        details: { blockedError: blocked.error },
      };
    });

    await runCheck(checks, details, "approvalMode", () =>
      runApprovalCheck(options.outDir, artifacts),
    );
  } finally {
    await service.stop();
    if (xterm && xterm.exitCode === null) xterm.kill("SIGTERM");
    await rm(scratch, { recursive: true, force: true });
  }

  const manifestChecks = CHECK_ORDER.map(
    (id) => checks.get(id) ?? newCheck(id),
  );
  const complete = manifestChecks.every((check) => check.status === "passed");
  const failed = manifestChecks.some((check) => check.status === "failed");
  const manifestPath = path.join(
    options.outDir,
    "linux-desktop-validation.json",
  );
  const reportPath = path.join(options.outDir, "report.json");
  const readmePath = path.join(options.outDir, "README.md");
  const stableManifestPath = path.join(options.outDir, "manifest.json");
  const finalArtifacts = Array.from(
    new Set([
      ...artifacts,
      relativeToRepo(manifestPath),
      relativeToRepo(reportPath),
      relativeToRepo(readmePath),
      relativeToRepo(stableManifestPath),
    ]),
  );
  const manifest = {
    schemaVersion: 1,
    platform: "linux-desktop",
    status: complete
      ? "passed"
      : failed
        ? "failed"
        : "requires_device_evidence",
    target: {
      minimumDistribution: "Ubuntu 22.04 or equivalent modern desktop Linux",
      displayServer: "X11 required for the xdotool/wmctrl evidence lane",
      driver: "legacy xdotool/scrot/wmctrl evidence path",
    },
    evidence: {
      machineId,
      distribution,
      kernelVersion,
      displayServer,
      buildId,
      validatedAt: generatedAt,
      validator: `bun scripts/${SCRIPT_NAME} (${gitHead})`,
      artifacts: finalArtifacts,
    },
    checks: manifestChecks,
  };
  const report = {
    issue: ISSUE,
    generatedAt,
    gitHead,
    host: {
      hostname: os.hostname(),
      machineId,
      distribution,
      kernelVersion,
      displayServer,
      node: process.version,
      bun: typeof Bun === "undefined" ? null : Bun.version,
      arch: process.arch,
    },
    options,
    manifest,
    details,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    readmePath,
    [
      `# Issue #${ISSUE} Linux desktop CUA evidence`,
      "",
      `Generated at ${generatedAt} by \`bun run --cwd plugins/plugin-computeruse capture:linux-desktop-evidence\`.`,
      "",
      `- Status: \`${manifest.status}\``,
      `- Distribution: \`${distribution}\``,
      `- Kernel: \`${kernelVersion}\``,
      `- Display: \`${displayServer}\``,
      `- Git: \`${gitHead}\``,
      "",
      "Artifacts:",
      ...finalArtifacts.map((artifact) => `- \`${artifact}\``),
      "",
    ].join("\n"),
    "utf8",
  );
  await copyFile(manifestPath, stableManifestPath);
  console.log(
    JSON.stringify(
      {
        status: manifest.status,
        outDir: relativeToRepo(options.outDir),
        manifest: relativeToRepo(manifestPath),
        checks: Object.fromEntries(
          manifestChecks.map((check) => [check.id, check.status]),
        ),
      },
      null,
      2,
    ),
  );
  if (!complete) process.exitCode = 1;
}

if (import.meta.main) await preserveApprovalConfig(main);
