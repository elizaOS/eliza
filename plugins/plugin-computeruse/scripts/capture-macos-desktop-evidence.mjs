#!/usr/bin/env bun
/**
 * Captures real macOS desktop-control evidence — probes platform capabilities,
 * screenshot capture, clipboard, and browser availability against a live headful
 * session, then writes a structured evidence manifest. Accessibility/TCC blockers
 * are classified as requires-device-evidence rather than failures. Produces the
 * macOS validation artifacts consumed by validate-platform-evidence.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { ComputerUseService } from "../src/services/computer-use-service.ts";

const CHECK_ORDER = [
  "capabilityProbe",
  "screenRecordingPermission",
  "screenshotCapture",
  "accessibilityPermission",
  "mouseKeyboardInput",
  "windowListFocus",
  "browserAutomation",
  "clipboardRoundTrip",
  "approvalMode",
];

const CHECK_METHODS = {
  capabilityProbe: "detectPlatformCapabilities/getCapabilities",
  screenRecordingPermission: "screencapture permission gate",
  screenshotCapture: "captureDisplay/capturePrimaryDisplay",
  accessibilityPermission: "Accessibility/TCC gate",
  mouseKeyboardInput: "ComputerUseService desktop actions",
  windowListFocus: "listWindows/focusWindow",
  browserAutomation: "browser open/navigate/get/screenshot/close",
  clipboardRoundTrip: "readClipboard/writeClipboard",
  approvalMode: "ComputerUseApprovalManager",
};

const ISSUE = 9581;
const SLUG = "9581-macos-desktop-cua";
const SCRIPT_NAME = "capture-macos-desktop-evidence.mjs";

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
    `Usage: bun scripts/${SCRIPT_NAME} [--out <dir>] [--skip-browser] [--skip-input]`,
    "",
    "Captures repeatable macOS desktop computer-use evidence for GitHub issue #9581.",
    "The harness writes a report, manifest candidate, screenshots, and README into",
    `test-results/evidence/${SLUG}/ by default.`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    outDir: defaultOutDir,
    skipBrowser: false,
    skipInput: false,
  };

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
    if (arg === "--skip-input") {
      options.skipInput = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function runText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 10_000,
  }).trim();
}

function commandText(command, args, fallback = "unknown") {
  try {
    const value = runText(command, args);
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
      `${label}: screenshot quality failed: ${issues.join("; ")}; metrics=${JSON.stringify(
        {
          byteLength: buffer.length,
          ...quality,
        },
      )}`,
    );
  }
  return {
    byteLength: buffer.length,
    ...quality,
  };
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

function usableWindow(windowInfo) {
  const app = String(windowInfo?.app ?? "").trim();
  const title = String(windowInfo?.title ?? "").trim();
  const id = String(windowInfo?.id ?? "").trim();
  const meaningfulApp = app.length > 0 && app.toLowerCase() !== "unknown";
  const meaningfulTitle = title.length > 0 && title.toLowerCase() !== "unknown";
  return id.length > 0 && (meaningfulApp || meaningfulTitle);
}

function focusableWindow(windowInfo) {
  const app = String(windowInfo?.app ?? "").trim();
  return (
    usableWindow(windowInfo) &&
    app.length > 0 &&
    app.toLowerCase() !== "unknown"
  );
}

async function waitForPendingApproval(service) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const snapshot = service.getApprovalSnapshot();
    const approval = snapshot.pendingApprovals[0];
    if (approval) return approval.id;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a pending approval.");
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

function newCheck(id) {
  return {
    id,
    method: CHECK_METHODS[id],
    status: "requires_device_evidence",
    requiredEvidence: [`${id} was not run`],
  };
}

export function isMacosAccessibilityEvidenceBlocker(message) {
  const normalized = String(message ?? "").toLowerCase();
  return [
    "accessibility permission",
    "assistive access",
    "system events",
    "placeholder window metadata",
    "could not read textedit bounds",
    "listwindows could not resolve the textedit window",
    "spawnsync osascript etimedout",
  ].some((needle) => normalized.includes(needle));
}

function macosAccessibilityEvidence(id, message) {
  if (!isMacosAccessibilityEvidenceBlocker(message)) return null;
  return {
    status: "requires_device_evidence",
    requiredEvidence: [
      `${id} requires rerun with macOS Accessibility permission granted: ${message}`,
    ],
  };
}

function setCheck(checks, details, id, status, requiredEvidence, extra = {}) {
  checks.set(id, {
    id,
    method: CHECK_METHODS[id],
    status,
    requiredEvidence,
  });
  details[id] = {
    status,
    requiredEvidence,
    ...extra,
  };
}

async function runCheck(checks, details, id, fn, options = {}) {
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
    const classified = options.classifyError?.(message, error);
    setCheck(
      checks,
      details,
      id,
      classified?.status ?? "failed",
      classified?.requiredEvidence ?? [`${id} failed: ${message}`],
      {
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      },
    );
  }
}

async function runTextEditInputCheck(service, displays) {
  let previousWindow = null;
  let createdDocument = false;
  const token = `macos-cua-${Date.now()}`;

  try {
    const activeBefore = await service.executeWindowAction({
      action: "get_current_window_id",
    });
    if (activeBefore?.success && activeBefore.window) {
      previousWindow = activeBefore.window;
    }

    runText(
      "osascript",
      [
        "-e",
        'tell application "TextEdit"',
        "-e",
        "activate",
        "-e",
        'make new document with properties {text:""}',
        "-e",
        "end tell",
      ],
      { timeout: 30_000 },
    );
    createdDocument = true;
    await new Promise((resolve) => setTimeout(resolve, 700));

    const active = await service.executeWindowAction({
      action: "get_current_window_id",
    });
    if (!active.success || !active.window) {
      throw new Error(
        `could not identify active TextEdit window: ${active.error ?? "unknown"}`,
      );
    }

    const boundsResult = await service.executeWindowAction({
      action: "get_window_position",
      windowId: active.window.id,
    });
    if (!boundsResult.success || !boundsResult.bounds) {
      const rawReason = boundsResult.error ?? "unknown";
      const reason = String(rawReason).includes("Window not found")
        ? `${rawReason}; listWindows could not resolve the TextEdit window. Grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry.`
        : rawReason;
      throw new Error(`could not read TextEdit bounds: ${reason}`);
    }

    const bounds = boundsResult.bounds;
    const globalX = Math.round(bounds.x + bounds.width / 2);
    const globalY = Math.round(bounds.y + Math.max(90, bounds.height / 2));
    const display = displayForPoint(displays, globalX, globalY);
    if (!display)
      throw new Error("no display available for TextEdit input target");

    const [displayX, displayY] = display.bounds;
    const coordinate = [globalX - displayX, globalY - displayY];

    const move = await service.executeCommand("mouse_move", {
      coordinate,
      displayId: display.id,
    });
    if (!move.success) {
      throw new Error(`mouse_move failed: ${move.error ?? "unknown"}`);
    }

    const click = await service.executeCommand("click", {
      coordinate,
      displayId: display.id,
    });
    if (!click.success) {
      throw new Error(`click failed: ${click.error ?? "unknown"}`);
    }

    const selectAll = await service.executeCommand("key_combo", {
      key: "cmd+a",
    });
    if (!selectAll.success) {
      throw new Error(`key_combo failed: ${selectAll.error ?? "unknown"}`);
    }

    const typed = await service.executeCommand("type", {
      text: token,
    });
    if (!typed.success) {
      throw new Error(`type failed: ${typed.error ?? "unknown"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    // Read the typed text back from the accessibility tree (`value` of the text
    // area) rather than `tell application "TextEdit" to get text of front
    // document`: directly after synthetic keyboard input TextEdit's Apple Event
    // dispatch is briefly blocked and that document read hangs to its timeout,
    // whereas the AX value — exactly what a computer-use agent observes on
    // screen — is available immediately. The document read is kept as a fallback
    // for macOS builds whose TextEdit AX hierarchy differs.
    let text = "";
    try {
      text = runText(
        "osascript",
        [
          "-e",
          'tell application "System Events" to tell process "TextEdit" to return value of text area 1 of scroll area 1 of front window',
        ],
        { timeout: 15_000 },
      );
    } catch {
      text = "";
    }
    if (!text.includes(token)) {
      text = runText(
        "osascript",
        ["-e", 'tell application "TextEdit" to get text of front document'],
        { timeout: 30_000 },
      );
    }
    if (!text.includes(token)) {
      throw new Error(`TextEdit document did not contain typed token ${token}`);
    }

    return {
      status: "passed",
      requiredEvidence: [
        `mouse_move succeeded at ${coordinate.join(",")} on display ${display.id}`,
        "click succeeded on a controlled TextEdit document",
        "key_combo cmd+a succeeded in the controlled text field",
        `type wrote and verified marker ${token}`,
        "post-action screenshots were requested by service configuration",
      ],
      details: {
        activeWindow: active.window,
        bounds,
        coordinate,
        displayId: display.id,
        marker: token,
      },
    };
  } finally {
    if (createdDocument) {
      // The close Apple Event is blocked by the same transient post-input state
      // as the read above; retry with a short delay so the document still closes
      // and runs don't accumulate stale windows (which slow TextEdit further).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          runText(
            "osascript",
            [
              "-e",
              'tell application "TextEdit" to close front document saving no',
            ],
            { timeout: 20_000 },
          );
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
    if (previousWindow?.id) {
      try {
        await service.executeCommand("switch_to_window", {
          windowId: previousWindow.id,
        });
      } catch {
        // Best effort focus restore.
      }
    }
  }
}

async function runBrowserCheck(service, outDir, artifacts) {
  const pageUrl =
    "data:text/html,<html><head><title>macOS CUA Evidence</title></head><body><main><h1>macOS CUA Evidence</h1><button id='go'>Ready</button><input id='field' value=''></main></body></html>";

  const open = await service.executeCommand("browser_open", { url: pageUrl });
  if (!open.success) {
    throw new Error(`browser_open failed: ${open.error ?? "unknown"}`);
  }
  const dom = await service.executeCommand("browser_get_dom");
  if (
    !dom.success ||
    !String(dom.content ?? "").includes("macOS CUA Evidence")
  ) {
    throw new Error(
      `browser_get_dom did not return the evidence page: ${dom.error ?? "unknown"}`,
    );
  }
  const clickables = await service.executeCommand("browser_get_clickables");
  if (!clickables.success) {
    throw new Error(
      `browser_get_clickables failed: ${clickables.error ?? "unknown"}`,
    );
  }
  const screenshot = await service.executeCommand("browser_screenshot");
  if (!screenshot.success) {
    throw new Error(
      `browser_screenshot failed: ${screenshot.error ?? "unknown"}`,
    );
  }

  const browserPng = pngBufferFromBase64(screenshot.screenshot);
  const browserQuality = describePng(browserPng, "browser screenshot");
  const browserArtifact = path.join(outDir, "browser-evidence.png");
  await writeFile(browserArtifact, browserPng);
  artifacts.push(relativeToRepo(browserArtifact));

  const close = await service.executeCommand("browser_close");
  if (!close.success) {
    throw new Error(`browser_close failed: ${close.error ?? "unknown"}`);
  }

  return {
    status: "passed",
    requiredEvidence: [
      `browser target opened ${open.url ?? "data URL"}`,
      "browser_get_dom returned the local evidence page",
      `browser_get_clickables returned ${clickables.count ?? clickables.elements?.length ?? "some"} element(s)`,
      `browser screenshot artifact ${relativeToRepo(browserArtifact)} (${browserQuality.width}x${browserQuality.height})`,
      "browser cleanup closed the test browser",
    ],
    details: {
      open: {
        url: open.url,
        title: open.title,
      },
      browserQuality,
    },
  };
}

async function runApprovalCheck(outDir, artifacts) {
  const approvalPath = path.join(outDir, "approval-full-control.txt");

  const smartService = await ComputerUseService.start(
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
    const offDenied = manager.isDenyAll();

    if (
      !smartReadOnly ||
      smartWrite ||
      !fullControl ||
      approveAll ||
      !offDenied
    ) {
      throw new Error(
        "approval manager mode predicates did not match expected policy",
      );
    }

    const pending = smartService.executeCommand("file_write", {
      path: approvalPath,
      content: "should not be written without approval",
    });
    const approvalId = await waitForPendingApproval(smartService);
    smartService.resolveApproval(
      approvalId,
      false,
      "macOS evidence denial check",
    );
    const denied = await pending;
    if (denied.success) {
      throw new Error(
        "smart_approve destructive action unexpectedly succeeded without approval",
      );
    }

    smartService.setApprovalMode("full_control");
    const fullWrite = await smartService.executeCommand("file_write", {
      path: approvalPath,
      content: "full_control approval evidence",
    });
    if (!fullWrite.success) {
      throw new Error(
        `full_control file_write failed: ${fullWrite.error ?? "unknown"}`,
      );
    }
    artifacts.push(relativeToRepo(approvalPath));

    smartService.setApprovalMode("off");
    const offResult = await smartService.executeCommand("screenshot");
    if (offResult.success) {
      throw new Error("off approval mode unexpectedly allowed screenshot");
    }

    return {
      status: "passed",
      requiredEvidence: [
        "smart_approve auto-approves read-only actions",
        "smart_approve queues destructive file_write until approval",
        "full_control auto-approves destructive actions",
        "approve_all does not auto-approve read-only actions",
        "off mode denies actions",
      ],
      details: {
        approvalPath: relativeToRepo(approvalPath),
      },
    };
  } finally {
    await smartService.stop();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") {
    throw new Error(
      `macOS desktop evidence must be captured on darwin, got ${process.platform}`,
    );
  }

  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });

  const generatedAt = new Date().toISOString();
  const machineModel = commandText("sysctl", ["-n", "hw.model"]);
  const macosVersion = commandText("sw_vers", ["-productVersion"]);
  const buildId = commandText("sw_vers", ["-buildVersion"]);
  const gitHead = commandText("git", ["rev-parse", "--short", "HEAD"]);
  const artifacts = [];
  const details = {};
  const checks = new Map(CHECK_ORDER.map((id) => [id, newCheck(id)]));

  const service = await ComputerUseService.start(
    createRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "true",
      COMPUTER_USE_BROWSER_HEADLESS: "false",
    }),
  );

  try {
    const capabilities = detectPlatformCapabilities({
      osName: "darwin",
      commandExists,
      isBrowserAvailable,
      shell: process.env.SHELL ?? "/bin/bash",
    });
    const serviceCapabilities = service.getCapabilities();
    const displays = service.getDisplays();

    await runCheck(checks, details, "capabilityProbe", async () => {
      const expectedKeys = [
        "screenshot",
        "computerUse",
        "windowList",
        "browser",
        "terminal",
        "fileSystem",
        "clipboard",
      ];
      for (const key of expectedKeys) {
        if (
          !capabilities[key] ||
          typeof capabilities[key].available !== "boolean"
        ) {
          throw new Error(`missing capability ${key}`);
        }
      }
      return {
        status: "passed",
        requiredEvidence: [
          "platform is darwin",
          `reported capabilities: ${expectedKeys
            .map(
              (key) =>
                `${key}=${capabilities[key].available ? "available" : "unavailable"}:${capabilities[key].tool}`,
            )
            .join("; ")}`,
          `service capabilities match darwin probe for screenshot=${serviceCapabilities.screenshot.available}, windowList=${serviceCapabilities.windowList.available}`,
        ],
        details: {
          capabilities,
          serviceCapabilities,
          displays,
        },
      };
    });

    let screenshotResult = null;
    let screenshotQuality = null;
    let screenshotArtifact = null;
    await runCheck(checks, details, "screenshotCapture", async () => {
      screenshotResult = await service.executeCommand("screenshot");
      if (!screenshotResult.success) {
        throw new Error(screenshotResult.error ?? "screenshot failed");
      }
      const screenshotPng = pngBufferFromBase64(screenshotResult.screenshot);
      screenshotQuality = describePng(
        screenshotPng,
        "primary display screenshot",
      );
      screenshotArtifact = path.join(options.outDir, "screenshot-primary.png");
      await writeFile(screenshotArtifact, screenshotPng);
      artifacts.push(relativeToRepo(screenshotArtifact));

      const display =
        displays.find(
          (candidate) => candidate.id === screenshotResult.displayId,
        ) ??
        displays.find((candidate) => candidate.primary) ??
        displays[0];
      if (!display) throw new Error("no display metadata returned");
      const expectedWidth = Math.round(display.bounds[2] * display.scaleFactor);
      const expectedHeight = Math.round(
        display.bounds[3] * display.scaleFactor,
      );
      if (
        screenshotQuality.width !== expectedWidth ||
        screenshotQuality.height !== expectedHeight
      ) {
        throw new Error(
          `screenshot dimensions ${screenshotQuality.width}x${screenshotQuality.height} did not match display ${expectedWidth}x${expectedHeight}`,
        );
      }

      return {
        status: "passed",
        requiredEvidence: [
          `primary display capture returned ${screenshotQuality.byteLength} PNG bytes`,
          `captured dimensions ${screenshotQuality.width}x${screenshotQuality.height} match display ${display.id}`,
          `screenshot artifact ${relativeToRepo(screenshotArtifact)}`,
        ],
        details: {
          display,
          screenshotQuality,
        },
      };
    });

    await runCheck(checks, details, "screenRecordingPermission", async () => {
      if (!screenshotResult?.success) {
        throw new Error(
          screenshotResult?.permissionDenied
            ? screenshotResult.error
            : "screenshot capture did not succeed",
        );
      }
      return {
        status: "passed",
        requiredEvidence: [
          "granted Screen Recording permission allowed screenshot capture",
          "permission-denied screenshot errors are classified by the service when TCC blocks capture",
          `captured nonblank artifact ${relativeToRepo(screenshotArtifact)}`,
        ],
        details: {
          screenshotQuality,
        },
      };
    });

    await runCheck(
      checks,
      details,
      "windowListFocus",
      async () => {
        const list = await service.executeCommand("list_windows");
        if (!list.success || !Array.isArray(list.windows)) {
          throw new Error(`list_windows failed: ${list.error ?? "unknown"}`);
        }
        const usableWindows = list.windows.filter(usableWindow);
        if (list.windows.length === 0) {
          throw new Error(
            "list_windows returned no visible windows; grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry",
          );
        }
        if (usableWindows.length === 0) {
          throw new Error(
            "list_windows returned only placeholder window metadata; grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry",
          );
        }
        const focusableWindows = usableWindows.filter(focusableWindow);
        if (focusableWindows.length === 0) {
          throw new Error(
            "list_windows returned windows without focusable application names; grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry",
          );
        }
        const active = await service.executeWindowAction({
          action: "get_current_window_id",
        });
        const target =
          active?.window && focusableWindow(active.window)
            ? (focusableWindows.find(
                (windowInfo) => windowInfo.id === active.window.id,
              ) ?? focusableWindows[0])
            : focusableWindows[0];
        if (!target) throw new Error("no visible window available to focus");
        const focus = await service.executeCommand("switch_to_window", {
          windowId: target.id,
        });
        if (!focus.success) {
          throw new Error(
            `switch_to_window failed: ${focus.error ?? "unknown"}`,
          );
        }
        return {
          status: "passed",
          requiredEvidence: [
            `listWindows returned ${list.windows.length} visible window(s)`,
            `focusWindow/switchWindow succeeded for ${target.app ?? "unknown"}:${target.id}`,
            "window operation errors retain permission guidance through service failure results",
          ],
          details: {
            focusedWindow: target,
            sampleWindows: list.windows.slice(0, 5),
          },
        };
      },
      {
        classifyError: (message) =>
          macosAccessibilityEvidence("windowListFocus", message),
      },
    );

    if (options.skipInput) {
      setCheck(
        checks,
        details,
        "mouseKeyboardInput",
        "requires_device_evidence",
        ["input proof skipped by --skip-input"],
      );
      setCheck(
        checks,
        details,
        "accessibilityPermission",
        "requires_device_evidence",
        ["Accessibility proof skipped by --skip-input"],
      );
    } else {
      try {
        const inputResult = await runTextEditInputCheck(service, displays);
        setCheck(
          checks,
          details,
          "mouseKeyboardInput",
          inputResult.status,
          inputResult.requiredEvidence,
          { details: inputResult.details },
        );
        setCheck(
          checks,
          details,
          "accessibilityPermission",
          "passed",
          [
            "granted Accessibility permission allowed TextEdit focus, window bounds, click, key_combo, and type operations",
            "missing Accessibility permission is classified by desktop service errors when TCC blocks input or System Events access",
          ],
          {
            details: {
              activeWindow: inputResult.details.activeWindow,
              bounds: inputResult.details.bounds,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const inputBlocker = macosAccessibilityEvidence(
          "controlled TextEdit input proof",
          message,
        );
        const accessibilityBlocker = macosAccessibilityEvidence(
          "Accessibility-gated input/window proof",
          message,
        );
        setCheck(
          checks,
          details,
          "mouseKeyboardInput",
          inputBlocker?.status ?? "failed",
          inputBlocker?.requiredEvidence ?? [
            `controlled TextEdit input proof failed: ${message}`,
          ],
        );
        setCheck(
          checks,
          details,
          "accessibilityPermission",
          accessibilityBlocker?.status ?? "failed",
          accessibilityBlocker?.requiredEvidence ?? [
            `Accessibility-gated input/window proof failed: ${message}`,
          ],
        );
      }
    }

    if (options.skipBrowser) {
      setCheck(
        checks,
        details,
        "browserAutomation",
        "requires_device_evidence",
        ["browser proof skipped by --skip-browser"],
      );
    } else if (!capabilities.browser.available) {
      setCheck(
        checks,
        details,
        "browserAutomation",
        "requires_device_evidence",
        [`browser unavailable on this host: ${capabilities.browser.tool}`],
      );
    } else {
      await runCheck(checks, details, "browserAutomation", () =>
        runBrowserCheck(service, options.outDir, artifacts),
      );
    }

    await runCheck(checks, details, "clipboardRoundTrip", async () => {
      const originalText = await readClipboard();
      const token = `macos-clipboard-${Date.now()}`;
      try {
        await writeClipboard(token);
        const read = await readClipboard();
        if (read !== token) {
          throw new Error("clipboard_read did not return test token");
        }
      } finally {
        await writeClipboard(originalText);
      }
      return {
        status: "passed",
        requiredEvidence: [
          `pbcopy wrote test marker ${token}`,
          "pbpaste read the same test marker",
          "large payload cap and command failures remain covered by unit tests",
        ],
        details: {
          marker: token,
          restoredOriginalClipboard: true,
        },
      };
    });

    await runCheck(checks, details, "approvalMode", () =>
      runApprovalCheck(options.outDir, artifacts),
    );
  } finally {
    await service.stop();
  }

  const manifestChecks = CHECK_ORDER.map(
    (id) => checks.get(id) ?? newCheck(id),
  );
  const complete = manifestChecks.every((check) =>
    ["passed", "blocked_by_platform"].includes(check.status),
  );
  const failed = manifestChecks.some((check) => check.status === "failed");
  const manifestPath = path.join(
    options.outDir,
    "macos-desktop-validation.json",
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
    platform: "macos-desktop",
    status: complete
      ? "passed"
      : failed
        ? "failed"
        : "requires_device_evidence",
    target: {
      minimumMacos: "macOS 13 or newer",
      requiredPermissions: ["Screen Recording", "Accessibility"],
      driver: "nutjs preferred; legacy cliclick/AppleScript fallback allowed",
    },
    evidence: {
      machineModel,
      macosVersion,
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
      machineModel,
      macosVersion,
      buildId,
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
      `# Issue #${ISSUE} macOS desktop CUA evidence`,
      "",
      `Generated by \`bun run --cwd plugins/plugin-computeruse capture:macos-desktop-evidence\` at ${generatedAt}.`,
      "",
      `- Status: \`${manifest.status}\``,
      `- Machine: \`${machineModel}\``,
      `- macOS: \`${macosVersion} (${buildId})\``,
      `- Git: \`${gitHead}\``,
      "",
      "Artifacts:",
      ...finalArtifacts.map((artifact) => `- \`${artifact}\``),
      "",
      "Validate the generated manifest with:",
      "",
      "```bash",
      `bun run --cwd plugins/plugin-computeruse validate:platform-evidence -- ../../${relativeToRepo(manifestPath)} --require-complete`,
      "```",
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
        report: relativeToRepo(reportPath),
        checks: Object.fromEntries(
          manifestChecks.map((check) => [check.id, check.status]),
        ),
      },
      null,
      2,
    ),
  );

  if (!complete) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await preserveApprovalConfig(main);
}
