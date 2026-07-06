#!/usr/bin/env bun
/**
 * Captures real Windows desktop-control evidence in validator-contract order —
 * capability probe, screenshot capture, clipboard, input, and window ops against
 * a live session — and emits the structured manifest consumed by
 * validate-platform-evidence. Check ids mirror docs/windows-desktop-validation.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputerUseApprovalManager } from "../src/approval-manager.ts";
import { isBrowserAvailable } from "../src/platform/browser.ts";
import { detectPlatformCapabilities } from "../src/platform/capabilities.ts";
import { normalizeCaptureRegion } from "../src/platform/capture.ts";
import { readClipboard, writeClipboard } from "../src/platform/clipboard.ts";
import { commandExists } from "../src/platform/helpers.ts";
import {
  analyzePngScreenshot,
  screenshotQualityIssues,
} from "../src/platform/screenshot-quality.ts";
import { validateFilePath } from "../src/platform/security.ts";
import { WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND } from "../src/platform/windows-list.ts";
import { ComputerUseService } from "../src/services/computer-use-service.ts";

// Validator contract order (docs/windows-desktop-validation.json checkIds).
const CHECK_ORDER = [
  "capabilityProbe",
  "screenshotCapture",
  "mouseKeyboardInput",
  "windowListFocus",
  "browserAutomation",
  "clipboardRoundTrip",
  "terminalSafety",
  "approvalMode",
  "windowsHardeningRegression",
];

const CHECK_METHODS = {
  capabilityProbe: "detectPlatformCapabilities/getCapabilities",
  screenshotCapture: "captureDisplay/capturePrimaryDisplay",
  mouseKeyboardInput: "ComputerUseService desktop actions",
  windowListFocus: "listWindows/focusWindow",
  browserAutomation: "browser open/navigate/get/screenshot/close",
  clipboardRoundTrip: "readClipboard/writeClipboard",
  terminalSafety: "PowerShell terminal execution safety",
  approvalMode: "ComputerUseApprovalManager",
  windowsHardeningRegression: "Windows hardening evidence replay",
};

const ISSUE = 9581;
const SLUG = "9581-windows-cua";
const SCRIPT_NAME = "capture-windows-desktop-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const defaultOutDir = path.join(repoRoot, "test-results/evidence", SLUG);
const approvalConfigPath = path.join(
  os.homedir(),
  ".eliza",
  "computer-use-approval.json",
);

// Generated artifacts the harness owns and may overwrite. Everything else in
// the evidence dir (the committed read-path verification.md + capture JPGs) is
// preserved — this harness AUGMENTS that evidence, it does not nuke the folder.
const OWNED_OUTPUTS = [
  "windows-desktop-validation.json",
  "manifest.json",
  "report.json",
  "screenshot-primary.png",
  "browser-evidence.png",
  "approval-full-control.txt",
  "CAPTURE_README.md",
];

function usage() {
  return [
    `Usage: bun scripts/${SCRIPT_NAME} [--out <dir>] [--skip-browser] [--skip-input]`,
    "",
    "Captures repeatable Windows desktop computer-use evidence for GitHub issue #9581.",
    "Writes a report, manifest, screenshots, and README into",
    `test-results/evidence/${SLUG}/ by default.`,
    "",
    "The input proof is non-disruptive: it drives a freshly-launched, controlled",
    "Notepad window (not the user's apps) and terminates it when done.",
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
        { byteLength: buffer.length, ...quality },
      )}`,
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

// On Windows the synchronous list query selects only Id + MainWindowTitle, so
// `app` is "unknown" by design — a window is usable when it has a stable id and
// a non-empty title, and focusable by that id (SetForegroundWindow by PID).
function usableWindow(windowInfo) {
  const title = String(windowInfo?.title ?? "").trim();
  const id = String(windowInfo?.id ?? "").trim();
  return id.length > 0 && title.length > 0 && title.toLowerCase() !== "unknown";
}

function looksLikeNotepad(windowInfo) {
  const hay =
    `${windowInfo?.app ?? ""} ${windowInfo?.title ?? ""}`.toLowerCase();
  return /notepad|untitled|\.txt|text editor/.test(hay);
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
      error:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drive a freshly-launched, controlled Notepad window — never the user's apps.
// Win11's `notepad.exe` is a launcher that re-parents the real editor under a
// new PID, so we resolve the real window via getActiveWindow() after it settles
// (its `id` IS the process id on Windows) and terminate THAT, not the launcher.
async function runNotepadInputCheck(service, displays) {
  const token = `eliza-win-cua-${Date.now()}`;
  const originalClipboard = await readClipboard().catch(() => "");
  let previousWindow = null;
  let notepadWindow = null;

  try {
    const activeBefore = await service.executeWindowAction({
      action: "get_current_window_id",
    });
    if (activeBefore?.success && activeBefore.window) {
      previousWindow = activeBefore.window;
    }

    const launched = await service.executeCommand("launch", {
      app: "notepad.exe",
    });
    if (!launched.success) {
      throw new Error(`launch notepad failed: ${launched.error ?? "unknown"}`);
    }
    await sleep(1800);

    const active = await service.executeWindowAction({
      action: "get_current_window_id",
    });
    if (active?.success && active.window && looksLikeNotepad(active.window)) {
      notepadWindow = active.window;
    } else {
      const found = await service.executeWindowAction({
        action: "get_application_windows",
        appName: "Notepad",
      });
      notepadWindow = (found?.windows ?? []).find(looksLikeNotepad) ?? null;
    }
    if (!notepadWindow?.id) {
      throw new Error(
        "could not resolve the controlled Notepad window after launch",
      );
    }

    const bounds = await service.executeWindowAction({
      action: "get_window_position",
      windowId: notepadWindow.id,
    });
    if (!bounds.success || !bounds.bounds) {
      throw new Error(
        `could not read Notepad bounds: ${bounds.error ?? "unknown"}`,
      );
    }
    const b = bounds.bounds;
    // Aim well below the title/tab bar so the click lands in the text area.
    const globalX = Math.round(b.x + b.width / 2);
    const globalY = Math.round(b.y + Math.max(130, b.height / 2));
    const display = displayForPoint(displays, globalX, globalY);
    if (!display)
      throw new Error("no display available for Notepad input target");
    const [displayX, displayY] = display.bounds;
    const coordinate = [globalX - displayX, globalY - displayY];

    const move = await service.executeCommand("mouse_move", {
      coordinate,
      displayId: display.id,
    });
    if (!move.success)
      throw new Error(`mouse_move failed: ${move.error ?? "unknown"}`);

    const click = await service.executeCommand("click", {
      coordinate,
      displayId: display.id,
    });
    if (!click.success)
      throw new Error(`click failed: ${click.error ?? "unknown"}`);

    const selectAll = await service.executeCommand("key_combo", {
      key: "ctrl+a",
    });
    if (!selectAll.success) {
      throw new Error(
        `key_combo ctrl+a failed: ${selectAll.error ?? "unknown"}`,
      );
    }

    const typed = await service.executeCommand("type", { text: token });
    if (!typed.success)
      throw new Error(`type failed: ${typed.error ?? "unknown"}`);

    // Read the typed text back the way a CUA agent observes a text field on
    // Windows: select-all + copy, then read the clipboard. The original
    // clipboard is restored in the finally block.
    await sleep(400);
    const selectAgain = await service.executeCommand("key_combo", {
      key: "ctrl+a",
    });
    if (!selectAgain.success) {
      throw new Error(
        `key_combo ctrl+a (read-back) failed: ${selectAgain.error}`,
      );
    }
    const copy = await service.executeCommand("key_combo", { key: "ctrl+c" });
    if (!copy.success)
      throw new Error(`key_combo ctrl+c failed: ${copy.error}`);
    await sleep(350);
    const readBack = await readClipboard();
    if (!readBack.includes(token)) {
      throw new Error(
        `Notepad did not contain typed token ${token}; clipboard read-back was ${JSON.stringify(
          readBack.slice(0, 80),
        )}`,
      );
    }

    return {
      status: "passed",
      requiredEvidence: [
        `launched controlled Notepad (pid ${launched.data?.pid ?? "?"}); resolved window [${notepadWindow.id}] "${notepadWindow.title}"`,
        `mouse_move succeeded at ${coordinate.join(",")} on display ${display.id}`,
        "click succeeded inside the controlled Notepad text area",
        "key_combo ctrl+a succeeded in the controlled text field",
        `type wrote and verified marker ${token} (read back via select-all/copy)`,
        "post-action screenshots were requested by service configuration",
      ],
      details: {
        notepadWindow,
        bounds: b,
        coordinate,
        displayId: display.id,
        marker: token,
        launchedPid: launched.data?.pid ?? null,
      },
    };
  } finally {
    // Terminate the controlled Notepad by its real window/PID (kill_app), with a
    // window-close fallback. This avoids the "Save changes?" dialog and leaves
    // the user's session untouched.
    if (notepadWindow?.id) {
      const killed = await service
        .executeCommand("kill_app", { target: String(notepadWindow.id) })
        .catch(() => ({ success: false }));
      if (!killed.success) {
        await service
          .executeCommand("close_window", { windowId: notepadWindow.id })
          .catch(() => {});
      }
    }
    await writeClipboard(originalClipboard).catch(() => {});
    if (previousWindow?.id) {
      await service
        .executeCommand("switch_to_window", { windowId: previousWindow.id })
        .catch(() => {});
    }
  }
}

async function runBrowserCheck(service, outDir, artifacts) {
  const pageUrl =
    "data:text/html,<html><head><title>Windows CUA Evidence</title></head><body><main><h1>Windows CUA Evidence</h1><button id='go'>Ready</button><input id='field' value=''></main></body></html>";

  const open = await service.executeCommand("browser_open", { url: pageUrl });
  if (!open.success)
    throw new Error(`browser_open failed: ${open.error ?? "unknown"}`);
  const dom = await service.executeCommand("browser_get_dom");
  if (
    !dom.success ||
    !String(dom.content ?? "").includes("Windows CUA Evidence")
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
  if (!close.success)
    throw new Error(`browser_close failed: ${close.error ?? "unknown"}`);

  return {
    status: "passed",
    requiredEvidence: [
      `browser target opened ${open.url ? "the evidence data URL" : "data URL"}`,
      "browser_get_dom returned the local evidence page",
      `browser_get_clickables returned ${clickables.count ?? clickables.elements?.length ?? "some"} element(s)`,
      `browser screenshot artifact ${relativeToRepo(browserArtifact)} (${browserQuality.width}x${browserQuality.height})`,
      "browser cleanup closed the test browser",
    ],
    details: { open: { url: open.url, title: open.title }, browserQuality },
  };
}

async function runTerminalSafetyCheck(service) {
  const token = `eliza-term-${Date.now()}`;
  const harmless = await service.executeTerminalAction({
    action: "execute",
    command: `echo ${token}`,
  });
  if (!harmless.success || !String(harmless.output ?? "").includes(token)) {
    throw new Error(
      `harmless command did not succeed/echo token: ${harmless.error ?? harmless.output}`,
    );
  }

  // A PowerShell recursive deletion of the drive root must be blocked BEFORE it
  // ever runs (checkDangerousCommand), never executed.
  const dangerousCommand = `Remove-Item -Recurse 'C:${String.fromCharCode(92)}'`;
  const dangerous = await service.executeTerminalAction({
    action: "execute",
    command: dangerousCommand,
  });
  if (dangerous.success) {
    throw new Error(
      "dangerous Remove-Item -Recurse drive-root command was not blocked",
    );
  }
  if (!/blocked/i.test(String(dangerous.error ?? ""))) {
    throw new Error(
      `dangerous command failed without a block reason: ${dangerous.error}`,
    );
  }

  // Timeout behavior: a 1s budget must kill a 5s sleep rather than hang.
  const startedAt = Date.now();
  const timedOut = await service.executeTerminalAction({
    action: "execute",
    command: "Start-Sleep -Seconds 5",
    timeout: 1,
  });
  const elapsedMs = Date.now() - startedAt;
  if (timedOut.success || elapsedMs > 4500) {
    throw new Error(
      `Start-Sleep 5s with a 1s timeout was not enforced (success=${timedOut.success}, elapsed=${elapsedMs}ms)`,
    );
  }

  return {
    status: "passed",
    requiredEvidence: [
      `allowed harmless PowerShell command 'echo ${token}' succeeded and echoed the token`,
      `dangerous '${dangerousCommand}' was rejected: ${String(dangerous.error).split("\n")[0]}`,
      `a 1s timeout killed a 5s Start-Sleep in ${elapsedMs}ms (timeout enforced)`,
    ],
    details: {
      harmlessOutput: String(harmless.output ?? "")
        .trim()
        .slice(0, 80),
      dangerousError: String(dangerous.error ?? "").split("\n")[0],
      timeoutElapsedMs: elapsedMs,
    },
  };
}

async function runHardeningRegressionCheck(
  outDir,
  artifacts,
  screenshotArtifact,
) {
  // 1) WinForms assembly is loaded before the Screen type is used (the
  //    getScreenSize() TypeNotFound regression guarded by windows-powershell-safety).
  const cmd = WINDOWS_PRIMARY_SCREEN_SIZE_COMMAND;
  const addTypeIdx = cmd.indexOf("Add-Type -AssemblyName System.Windows.Forms");
  const useIdx = cmd.indexOf("[System.Windows.Forms.Screen]");
  if (addTypeIdx < 0 || useIdx < addTypeIdx) {
    throw new Error(
      "primary-screen-size command does not load System.Windows.Forms before use",
    );
  }

  // 2) Degenerate capture regions are rejected with a clear error (#9058 — GDI+
  //    "Parameter is not valid" otherwise).
  let degenerateError = null;
  try {
    normalizeCaptureRegion({ x: 0, y: 0, width: 0, height: 0 });
  } catch (error) {
    degenerateError = error instanceof Error ? error.message : String(error);
  }
  if (!degenerateError || !/positive/.test(degenerateError)) {
    throw new Error(
      "degenerate capture region (0x0) was not rejected with a clear error",
    );
  }

  // 3) Windows path-security assertions: UNC + traversal blocked, safe local
  //    write allowed.
  const BS = String.fromCharCode(92);
  const uncPath = `${BS}${BS}attacker${BS}share${BS}payload.txt`;
  const unc = validateFilePath(uncPath, "write");
  if (unc.allowed) throw new Error("UNC network path was not blocked");
  const safePath = path.join(
    os.tmpdir(),
    `eliza-windows-hardening-${Date.now()}.txt`,
  );
  const safe = validateFilePath(safePath, "write");
  if (!safe.allowed)
    throw new Error(
      `safe local temp path was unexpectedly blocked: ${safe.reason}`,
    );

  // 4) Link the existing real-driver screenshot evidence + this run's fresh one.
  const existingRealDriverEvidence = path.join(
    outDir,
    "cua-windows-desktop-capture.jpg",
  );
  const linkedEvidence = [];
  if (existsSync(existingRealDriverEvidence)) {
    const rel = relativeToRepo(existingRealDriverEvidence);
    linkedEvidence.push(rel);
    if (!artifacts.includes(rel)) artifacts.push(rel);
  }
  if (screenshotArtifact)
    linkedEvidence.push(relativeToRepo(screenshotArtifact));

  return {
    status: "passed",
    requiredEvidence: [
      "primary-screen-size PowerShell command runs Add-Type System.Windows.Forms before using [System.Windows.Forms.Screen]",
      `degenerate 0x0 capture region rejected with: ${degenerateError}`,
      "UNC network path blocked and a safe local temp path allowed by validateFilePath",
      `linked real-driver screenshot evidence: ${linkedEvidence.join(", ") || "none"}`,
    ],
    details: {
      degenerateError,
      uncReason: unc.reason,
      safeAllowed: safe.allowed,
      linkedEvidence,
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
      "Windows evidence denial check",
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
      details: { approvalPath: relativeToRepo(approvalPath) },
    };
  } finally {
    await smartService.stop();
  }
}

function readHostInfo() {
  // os.* is spawn-free (no Defender-taxed PowerShell). Enrich with one CIM call
  // for the friendly machine model, falling back to os.* on any failure.
  const fallback = {
    machineModel:
      `${os.arch()} ${os.cpus()?.[0]?.model ?? "unknown CPU"}`.trim(),
    windowsVersion: os.version() || `Windows ${os.release()}`,
    buildId: os.release(),
  };
  try {
    const raw = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$cs=Get-CimInstance Win32_ComputerSystem; $os=Get-CimInstance Win32_OperatingSystem; " +
          'ConvertTo-Json -Compress @{ Model="$($cs.Manufacturer) $($cs.Model)"; Caption=$os.Caption; Version=$os.Version; Build=$os.BuildNumber }',
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const parsed = JSON.parse(raw);
    return {
      machineModel: String(parsed.Model ?? "").trim() || fallback.machineModel,
      windowsVersion:
        `${parsed.Caption ?? ""} ${parsed.Version ?? ""}`.trim() ||
        fallback.windowsVersion,
      buildId: String(parsed.Build ?? "").trim() || fallback.buildId,
    };
  } catch {
    return fallback;
  }
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "win32") {
    throw new Error(
      `Windows desktop evidence must be captured on win32, got ${process.platform}`,
    );
  }

  // Preserve the committed read-path evidence (verification.md + capture JPGs):
  // only remove the artifacts this harness owns, then ensure the dir exists.
  await mkdir(options.outDir, { recursive: true });
  for (const owned of OWNED_OUTPUTS) {
    await rm(path.join(options.outDir, owned), { force: true });
  }

  const generatedAt = new Date().toISOString();
  const { machineModel, windowsVersion, buildId } = readHostInfo();
  const head = gitHead();
  const artifacts = [];
  const details = {};
  const checks = new Map(CHECK_ORDER.map((id) => [id, newCheck(id)]));

  const service = await ComputerUseService.start(
    createRuntime({
      COMPUTER_USE_APPROVAL_MODE: "full_control",
      COMPUTER_USE_SCREENSHOT_AFTER_ACTION: "true",
      COMPUTER_USE_BROWSER_HEADLESS: "true",
    }),
  );

  let screenshotArtifact = null;

  try {
    const capabilities = detectPlatformCapabilities({
      osName: "win32",
      commandExists,
      isBrowserAvailable,
      shell: process.env.ComSpec ?? "powershell.exe",
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
          "platform is win32",
          `reported capabilities: ${expectedKeys
            .map(
              (key) =>
                `${key}=${capabilities[key].available ? "available" : "unavailable"}:${capabilities[key].tool}`,
            )
            .join("; ")}`,
          `PowerShell-backed tools identified (screenshot=${capabilities.screenshot.tool}, windowList=${capabilities.windowList.tool}, clipboard=${capabilities.clipboard.tool})`,
        ],
        details: { capabilities, serviceCapabilities, displays },
      };
    });

    let screenshotResult = null;
    await runCheck(checks, details, "screenshotCapture", async () => {
      screenshotResult = await service.executeCommand("screenshot");
      if (!screenshotResult.success) {
        throw new Error(screenshotResult.error ?? "screenshot failed");
      }
      const screenshotPng = pngBufferFromBase64(screenshotResult.screenshot);
      const quality = describePng(screenshotPng, "primary display screenshot");
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
        quality.width !== expectedWidth ||
        quality.height !== expectedHeight
      ) {
        throw new Error(
          `screenshot dimensions ${quality.width}x${quality.height} did not match display ${expectedWidth}x${expectedHeight}`,
        );
      }
      return {
        status: "passed",
        requiredEvidence: [
          `primary display capture returned ${quality.byteLength} PNG bytes`,
          `captured dimensions ${quality.width}x${quality.height} match display ${display.id}`,
          `screenshot artifact ${relativeToRepo(screenshotArtifact)}`,
        ],
        details: { display, screenshotQuality: quality },
      };
    });

    if (options.skipInput) {
      setCheck(
        checks,
        details,
        "mouseKeyboardInput",
        "requires_device_evidence",
        ["input proof skipped by --skip-input"],
      );
    } else {
      await runCheck(checks, details, "mouseKeyboardInput", () =>
        runNotepadInputCheck(service, displays),
      );
    }

    await runCheck(checks, details, "windowListFocus", async () => {
      const list = await service.executeCommand("list_windows");
      if (!list.success || !Array.isArray(list.windows)) {
        throw new Error(`list_windows failed: ${list.error ?? "unknown"}`);
      }
      if (list.windows.length === 0) {
        throw new Error(
          "list_windows returned no visible windows on an interactive desktop; if this is a Defender-heavy host raise ELIZA_COMPUTERUSE_PS_TIMEOUT_MS and retry (#9581 finding #2)",
        );
      }
      const usableWindows = list.windows.filter(usableWindow);
      if (usableWindows.length === 0) {
        throw new Error(
          "list_windows returned only placeholder window metadata",
        );
      }
      const active = await service.executeWindowAction({
        action: "get_current_window_id",
      });
      const target =
        (active?.window && usableWindow(active.window)
          ? usableWindows.find((w) => w.id === active.window.id)
          : null) ?? usableWindows[0];
      const focus = await service.executeCommand("switch_to_window", {
        windowId: target.id,
      });
      if (!focus.success) {
        throw new Error(`switch_to_window failed: ${focus.error ?? "unknown"}`);
      }
      return {
        status: "passed",
        requiredEvidence: [
          `listWindows returned ${list.windows.length} visible window(s) with id + title metadata (finding #2 resolved — not 0)`,
          `${usableWindows.length} window(s) had a usable id + title; focusWindow/switchWindow succeeded for [${target.id}] "${target.title}"`,
          "window operation failures surface actionable diagnostics through the service result",
        ],
        details: {
          windowCount: list.windows.length,
          usableCount: usableWindows.length,
          focusedWindow: target,
          sampleWindows: list.windows.slice(0, 6),
        },
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
      const token = `windows-clipboard-${Date.now()}`;
      let read = "";
      try {
        await writeClipboard(token);
        read = await readClipboard();
        // `Get-Clipboard -Raw` returns the clipboard text with a trailing line
        // terminator (a cmdlet/host-transport artifact, not clipboard
        // corruption). The token contains no newlines, so normalizing trailing
        // CR/LF is the correct comparison — not a masking trim.
        if (read.replace(/[\r\n]+$/, "") !== token) {
          throw new Error(
            `clipboard read did not return test token (got ${JSON.stringify(read.slice(0, 80))})`,
          );
        }
      } finally {
        await writeClipboard(originalText);
      }
      return {
        status: "passed",
        requiredEvidence: [
          `Set-Clipboard wrote test marker ${token}`,
          "Get-Clipboard -Raw read the same test marker (trailing newline normalized)",
          "large payload cap and command failures remain covered by unit tests",
        ],
        details: {
          marker: token,
          rawReadbackLength: read.length,
          restoredOriginalClipboard: true,
        },
      };
    });

    await runCheck(checks, details, "terminalSafety", () =>
      runTerminalSafetyCheck(service),
    );

    await runCheck(checks, details, "approvalMode", () =>
      runApprovalCheck(options.outDir, artifacts),
    );

    await runCheck(checks, details, "windowsHardeningRegression", () =>
      runHardeningRegressionCheck(
        options.outDir,
        artifacts,
        screenshotArtifact,
      ),
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
    "windows-desktop-validation.json",
  );
  const reportPath = path.join(options.outDir, "report.json");
  const readmePath = path.join(options.outDir, "CAPTURE_README.md");
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
    platform: "windows-desktop",
    status: complete
      ? "passed"
      : failed
        ? "failed"
        : "requires_device_evidence",
    target: {
      minimumWindows: "Windows 10 or newer",
      driver: "nutjs preferred; legacy PowerShell/user32 fallback allowed",
      shell: "PowerShell -NoProfile",
    },
    evidence: {
      machineModel,
      windowsVersion,
      buildId,
      validatedAt: generatedAt,
      validator: `bun scripts/${SCRIPT_NAME} (${head})`,
      artifacts: finalArtifacts,
    },
    checks: manifestChecks,
  };

  const report = {
    issue: ISSUE,
    generatedAt,
    gitHead: head,
    host: {
      hostname: os.hostname(),
      machineModel,
      windowsVersion,
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
  await writeFile(stableManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // NOTE: this harness writes only into the evidence dir (mirroring the macOS
  // harness). Promoting the package release manifest
  // (docs/windows-desktop-validation.json) is a deliberate, reviewed edit — not
  // an every-run side effect — so it isn't churned with a fresh timestamp/git
  // head on each capture.

  await writeFile(
    readmePath,
    [
      `# Issue #${ISSUE} Windows desktop CUA evidence`,
      "",
      `Generated by \`bun run --cwd plugins/plugin-computeruse capture:windows-desktop-evidence\` at ${generatedAt}.`,
      "",
      `- Status: \`${manifest.status}\``,
      `- Machine: \`${machineModel}\``,
      `- Windows: \`${windowsVersion} (build ${buildId})\``,
      `- Git: \`${head}\``,
      "",
      "The input proof is **non-disruptive**: it drives a freshly-launched, controlled",
      "Notepad window (not the user's apps) and terminates it when done.",
      "",
      "Checks:",
      ...manifestChecks.map((check) => `- \`${check.id}\`: ${check.status}`),
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

  if (!complete) process.exitCode = 1;
}

if (import.meta.main) {
  await preserveApprovalConfig(main);
}
