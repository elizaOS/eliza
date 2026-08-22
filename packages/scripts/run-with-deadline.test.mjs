/**
 * Real-process process-group supervision harness for run-with-deadline. These
 * tests spawn actual Node children and descendants; no child lifecycle is mocked.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("./run-with-deadline.mjs", import.meta.url),
);
const WINDOWS_HELPER = fileURLToPath(
  new URL("./run-with-deadline-windows.ps1", import.meta.url),
);
const WINDOWS_COMMAND_SPEC_ENV = "ELIZA_RUN_WITH_DEADLINE_COMMAND_SPEC";

function readPidIfPresent(file) {
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8"));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function probeWindowsFixture(pid, expectedScript) {
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  const command = [
    "try {",
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    // error-policy:J1 CIM query failure is an unknown identity, never absence.
    "} catch { exit 4 }",
    "if ($null -eq $process) { exit 3 }",
    "[Console]::Write($process.CommandLine)",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 1_000,
      maxBuffer: 8_192,
    },
  );
  if (!result.error && result.status === 3) return "absent";
  if (result.error || result.status !== 0) return "unknown";
  const commandLine =
    typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!commandLine) return "unknown";
  return commandLine.toLowerCase().includes(expectedScript.toLowerCase())
    ? "fixture"
    : "replaced";
}

function isWindowsFixtureGone(pid, expectedScript) {
  const state = probeWindowsFixture(pid, expectedScript);
  if (state === "unknown") {
    throw new Error(`could not prove fixture PID ${pid} was reaped`);
  }
  return state === "absent" || state === "replaced";
}

function killWindowsFixtureSafely(pid, expectedScript) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return "absent";
  }
  const initialState = probeWindowsFixture(pid, expectedScript);
  if (initialState === "unknown") {
    throw new Error(`could not identify fixture PID ${pid} before cleanup`);
  }
  if (initialState !== "fixture") {
    return initialState;
  }
  const encodedExpected = Buffer.from(expectedScript, "utf8").toString(
    "base64",
  );
  const command = `
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DeadlineFixtureCleanup {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public uint Low;
    public uint High;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(
    uint access,
    bool inheritHandle,
    uint processId
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(
    IntPtr process,
    out FILETIME creation,
    out FILETIME exit,
    out FILETIME kernel,
    out FILETIME user
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(
    IntPtr handle,
    uint milliseconds
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public static long GetCreationFileTime(IntPtr process) {
    FILETIME creation;
    FILETIME exit;
    FILETIME kernel;
    FILETIME user;
    if (!GetProcessTimes(
      process,
      out creation,
      out exit,
      out kernel,
      out user
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return ((long)creation.High << 32) | creation.Low;
  }
}
"@

$expectedScript = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String('${encodedExpected}')
)

$handle = [DeadlineFixtureCleanup]::OpenProcess(
  0x00101001,
  $false,
  ${pid}
)
if ($handle -eq [IntPtr]::Zero) { exit 3 }
try {
  $nativeCreated = [DateTime]::FromFileTimeUtc(
    [DeadlineFixtureCleanup]::GetCreationFileTime($handle)
  )
  $fixture = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop
  if ($null -eq $fixture) { exit 4 }
  if (
    [String]::IsNullOrEmpty($fixture.CommandLine) -or
    $fixture.CommandLine.IndexOf(
      $expectedScript,
      [StringComparison]::OrdinalIgnoreCase
    ) -lt 0
  ) {
    exit 5
  }
  $cimCreated = ([DateTime] $fixture.CreationDate).ToUniversalTime()
  if ([Math]::Abs(($nativeCreated - $cimCreated).TotalSeconds) -gt 1) {
    exit 6
  }
  if (-not [DeadlineFixtureCleanup]::TerminateProcess($handle, 1)) {
    exit 7
  }
  if ([DeadlineFixtureCleanup]::WaitForSingleObject($handle, 2000) -ne 0) {
    exit 8
  }
} finally {
  [void] [DeadlineFixtureCleanup]::CloseHandle($handle)
}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `safe cleanup failed for fixture PID ${pid} ` +
        `(status=${result.status}, error=${String(result.error)}, ` +
        `stderr=${String(result.stderr).trim()})`,
    );
  }
  return "terminated";
}

function cleanupWindowsFixtures(fixtures) {
  let firstError;
  for (const [pid, expectedScript] of fixtures) {
    try {
      killWindowsFixtureSafely(pid, expectedScript);
    } catch (error) {
      // error-policy:J1 Test teardown attempts every known fixture, then fails
      // instead of hiding an unproven survivor behind the primary assertion.
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(file);
}

test("safely cleans Windows fixtures with shell-sensitive paths", {
  timeout: 15_000,
  skip: process.platform !== "win32" ? "Windows cleanup contract" : false,
}, async (context) => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run with deadline & cleanup's-"),
  );
  const readyFile = path.join(root, "ready");
  const fixture = path.join(root, "fixture & child.mjs");
  writeFileSync(
    fixture,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setTimeout(() => process.exit(99), 30_000).unref();
setInterval(() => {}, 1000);
`,
  );
  const fixtureProcess = spawn(process.execPath, [fixture], {
    stdio: "ignore",
    windowsHide: true,
  });
  context.after(() => {
    let cleanupError;
    try {
      cleanupWindowsFixtures([[fixtureProcess.pid, fixture]]);
    } catch (error) {
      // error-policy:J6 This retained ChildProcess owns the original process
      // handle, so it is the PID-reuse-safe fallback when CIM proof is denied.
      cleanupError = error;
      fixtureProcess.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
    if (cleanupError) throw cleanupError;
  });

  assert.equal(
    await waitForPath(readyFile, 5_000),
    true,
    "cleanup fixture did not start",
  );
  assert.equal(probeWindowsFixture(fixtureProcess.pid, fixture), "fixture");
  assert.equal(
    killWindowsFixtureSafely(
      fixtureProcess.pid,
      path.join(root, "different & child.mjs"),
    ),
    "replaced",
    "identity mismatch should refuse termination",
  );
  assert.equal(
    probeWindowsFixture(fixtureProcess.pid, fixture),
    "fixture",
    "identity mismatch terminated the real fixture",
  );
  assert.equal(
    killWindowsFixtureSafely(fixtureProcess.pid, fixture),
    "terminated",
  );
  assert.equal(
    isWindowsFixtureGone(fixtureProcess.pid, fixture),
    true,
    "fixture survived safe handle-based cleanup",
  );
});

test("preserves normal child output and exit status", {
  timeout: 10_000,
}, () => {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "5000",
      "--",
      "node",
      "-e",
      'process.stdout.write("deadline-normal-output"); process.exit(7)',
    ],
    { encoding: "utf8", timeout: 8_000 },
  );

  assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "deadline-normal-output");
});

test("preserves Windows argument boundaries", {
  timeout: 10_000,
  skip:
    process.platform !== "win32" ? "Windows native quoting contract" : false,
}, () => {
  const expected = ["", "two words", 'quote"inside', "trailing\\"];
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "5000",
      "--",
      "node",
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      ...expected,
    ],
    { encoding: "utf8", timeout: 8_000 },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("selects the first matching Windows application on PATH", {
  timeout: 15_000,
  skip: process.platform !== "win32" ? "Windows PATH contract" : false,
}, () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run-with-deadline-windows-path-"),
  );
  const firstDirectory = path.join(root, "first");
  const secondDirectory = path.join(root, "second");
  const executableName = "eliza-deadline-path-order.exe";
  const firstExecutable = path.join(firstDirectory, executableName);
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  linkSync(process.execPath, firstExecutable);
  linkSync(process.execPath, path.join(secondDirectory, executableName));

  try {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "5000",
        "--",
        executableName,
        "-e",
        "process.stdout.write(process.execPath)",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${firstDirectory};${secondDirectory};${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.toLowerCase(), firstExecutable.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves high-bit Windows process exit codes", {
  timeout: 10_000,
  skip: process.platform !== "win32" ? "Windows exit-code contract" : false,
}, () => {
  const direct = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "exit -1073741819"],
    { windowsHide: true },
  );
  const wrapped = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "5000",
      "--",
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit -1073741819",
    ],
    { encoding: "utf8", timeout: 8_000 },
  );

  // Bun currently exposes only the low byte of a Windows native exit status;
  // Node exposes the full unsigned DWORD. The wrapper must preserve whichever
  // representation its calling runtime exposes.
  const expectedDirectStatus = process.versions.bun
    ? 3_221_225_477 & 0xff
    : 3_221_225_477;
  assert.equal(direct.status, expectedDirectStatus);
  assert.equal(wrapped.status, direct.status, wrapped.stderr);
});

test("preserves a completed Windows leader status after draining descendants", {
  timeout: 15_000,
  skip: process.platform !== "win32" ? "Windows Job Object contract" : false,
}, () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run-with-deadline-windows-complete-"),
  );
  const descendantPidFile = path.join(root, "descendant.pid");
  const readyFile = path.join(root, "ready");
  const descendant = path.join(root, "descendant.mjs");
  const child = path.join(root, "child.mjs");
  let descendantPid;
  let descendantGone = false;
  writeFileSync(
    descendant,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
const ready = setInterval(() => {
  if (existsSync(${JSON.stringify(readyFile)})) {
    clearInterval(ready);
    process.exit(9);
  }
}, 10);
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "5000", "--", process.execPath, child],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 9, `${result.stdout}\n${result.stderr}`);
    descendantPid = readPidIfPresent(descendantPidFile);
    assert.ok(descendantPid, "descendant did not report its PID");
    descendantGone = isWindowsFixtureGone(descendantPid, descendant);
    assert.equal(
      descendantGone,
      true,
      `descendant PID ${descendantPid} survived normal leader completion`,
    );
  } finally {
    descendantPid ??= readPidIfPresent(descendantPidFile);
    try {
      if (!descendantGone) {
        cleanupWindowsFixtures([[descendantPid, descendant]]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("returns 127 when the command cannot start", { timeout: 10_000 }, () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "5000", "--", "eliza-command-that-does-not-exist-24497"],
    { encoding: "utf8", timeout: 8_000 },
  );

  assert.equal(result.status, 127, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /failed to (?:start|start Windows command)/i);
});

test("lets an already-expired Windows deadline beat command lookup failure", {
  timeout: 10_000,
  skip: process.platform !== "win32" ? "Windows decision contract" : false,
}, () => {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, "1", "--", "eliza-command-that-does-not-exist-after-deadline"],
    { encoding: "utf8", timeout: 8_000 },
  );

  assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /wall-clock deadline of 1ms exceeded/);
});

test("fails closed when the Windows supervisor misses its settle bound", {
  timeout: 25_000,
  skip: process.platform !== "win32" ? "Windows watchdog contract" : false,
}, () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run-with-deadline-windows-watchdog-"),
  );
  const copiedScript = path.join(root, "run-with-deadline.mjs");
  const stalledHelper = path.join(root, "run-with-deadline-windows.ps1");
  copyFileSync(SCRIPT, copiedScript);
  // This exceeds the 12-second watchdog but self-terminates before the test's
  // 20-second hard ceiling if the watchdog regresses.
  writeFileSync(stalledHelper, "Start-Sleep -Seconds 16\n");

  try {
    const result = spawnSync(
      process.execPath,
      [copiedScript, "1", "--", process.execPath, "-e", "process.exit(0)"],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /did not settle within 12000ms after its deadline/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reaps a suspended Windows target when the deadline wins before resume", {
  timeout: 15_000,
  skip: process.platform !== "win32" ? "Windows Job Object contract" : false,
}, () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run-with-deadline-windows-suspended-"),
  );
  const createdPidFile = path.join(root, "created.pid");
  const startedFile = path.join(root, "started");
  const child = path.join(root, "child.mjs");
  writeFileSync(
    child,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(startedFile)}, "started");
setInterval(() => {}, 1000);
`,
  );

  let childPid;
  try {
    const deadlineMs = 30_000;
    const encodedSpec = Buffer.from(
      JSON.stringify({
        command: process.execPath,
        args: [child],
        deadlineMs,
        deadlineAtTickMs: Math.floor(os.uptime() * 1000) + deadlineMs,
      }),
      "utf8",
    ).toString("base64");
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        WINDOWS_HELPER,
        "-TestOnlyExpireAfterCreatePidFile",
        createdPidFile,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          [WINDOWS_COMMAND_SPEC_ENV]: encodedSpec,
        },
      },
    );
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    childPid = readPidIfPresent(createdPidFile);
    assert.ok(childPid, "helper did not create the target suspended");
    assert.equal(
      existsSync(startedFile),
      false,
      "suspended target executed before deadline cleanup",
    );
    assert.equal(
      isWindowsFixtureGone(childPid, child),
      true,
      `suspended target PID ${childPid} survived deadline cleanup`,
    );
  } finally {
    childPid ??= readPidIfPresent(createdPidFile);
    try {
      cleanupWindowsFixtures([[childPid, child]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("waits for forced Windows child-tree cleanup before exiting 124", {
  timeout: 25_000,
  skip: process.platform !== "win32" ? "Windows Job Object contract" : false,
}, () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "run-with-deadline-windows-"),
  );
  const childPidFile = path.join(root, "child.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const readyFile = path.join(root, "ready");
  const descendant = path.join(root, "descendant.mjs");
  const child = path.join(root, "child.mjs");
  let childPid;
  let descendantPid;
  let childGone = false;
  let descendantGone = false;
  writeFileSync(
    descendant,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(descendantPidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(readyFile)}, "ready");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "5000", "--", process.execPath, child],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.ok(
      existsSync(readyFile),
      `descendant did not signal readiness (status=${result.status}, signal=${result.signal}, error=${String(result.error)})\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    childPid = readPidIfPresent(childPidFile);
    descendantPid = readPidIfPresent(descendantPidFile);
    assert.ok(childPid, "child did not report its PID");
    assert.ok(descendantPid, "descendant did not report its PID");
    childGone = isWindowsFixtureGone(childPid, child);
    assert.equal(
      childGone,
      true,
      `child PID ${childPid} survived the deadline`,
    );
    descendantGone = isWindowsFixtureGone(descendantPid, descendant);
    assert.equal(
      descendantGone,
      true,
      `descendant PID ${descendantPid} survived the deadline`,
    );
  } finally {
    childPid ??= readPidIfPresent(childPidFile);
    descendantPid ??= readPidIfPresent(descendantPidFile);
    try {
      cleanupWindowsFixtures([
        ...(childGone ? [] : [[childPid, child]]),
        ...(descendantGone ? [] : [[descendantPid, descendant]]),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("waits for SIGKILL escalation when the direct child closes first", {
  timeout: 20_000,
  skip: process.platform === "win32" ? "POSIX process-group contract" : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-with-deadline-"));
  const pidFile = path.join(root, "descendant.pid");
  const descendant = path.join(root, "descendant.mjs");
  const readyFile = path.join(root, "ready");
  const child = path.join(root, "child.mjs");
  writeFileSync(
    descendant,
    `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(readyFile)}, "ready");
setInterval(() => {}, 1000);
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "2000", "--", process.execPath, child],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.ok(existsSync(readyFile), "descendant did not signal readiness");
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    assert.match(result.stderr, /termination grace expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settles without escalation when a descendant honors SIGTERM", {
  timeout: 25_000,
  skip: process.platform === "win32" ? "POSIX process-group contract" : false,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-with-deadline-grace-"));
  const readyFile = path.join(root, "ready");
  const descendant = path.join(root, "descendant.mjs");
  const child = path.join(root, "child.mjs");
  writeFileSync(
    descendant,
    `import { writeFileSync } from "node:fs";
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
writeFileSync(${JSON.stringify(readyFile)}, "ready");
`,
  );
  writeFileSync(
    child,
    `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "2000", "--", process.execPath, child],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(readyFile), "descendant did not signal readiness");
    assert.doesNotMatch(result.stderr, /termination grace expired/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
