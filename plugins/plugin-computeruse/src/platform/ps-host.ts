/**
 * Warm PowerShell host (Windows-only) — eliminates the cold-spawn tax.
 *
 * On Windows, every capability that shells out to `powershell.exe`
 * (screen capture, clipboard, window/display enumeration) pays the cost of
 * starting a fresh process. On Defender-heavy hosts real-time AV scans each new
 * process image, which measured **~10-12s per cold `powershell.exe` spawn** on a
 * build box (see #9581). The CUA scene pipeline grabs the screen — and several
 * dirty regions — every turn, so that tax compounds.
 *
 * This module keeps ONE long-lived `powershell.exe` alive and feeds it commands
 * over stdin, reading results back over stdout. The first call pays the cold
 * spawn once; every call after that runs in the already-warm process
 * (sub-second). It is a pure latency optimization: callers wrap their existing
 * one-shot PowerShell invocation and fall back to it transparently whenever the
 * host is unavailable, disabled, or errors — so behavior is unchanged, only
 * faster.
 *
 * The loop runs from a temp `.ps1` via `powershell -File` (NOT `-Command -`,
 * which would consume stdin to build the program and starve the loop's own
 * `ReadLine`). `-File` reads the program from disk, leaving stdin free for the
 * loop to read request lines.
 *
 * Protocol (host side is a tiny ReadLine server loop, see `SERVER_LOOP`):
 *   - JS writes ONE line per request: `<token> <base64-utf8-script>\n`.
 *     base64 guarantees the payload is single-line and escaping-free.
 *   - The host decodes the script, runs it in a child scope (`& {…}` via a
 *     fresh ScriptBlock, so request state never leaks), then writes the script's
 *     stdout followed by the bare `<token>` (no newline). On a terminating
 *     error it writes `PSHOSTERR:<message>` before the token.
 *   - JS accumulates stdout until it sees `<token>`; everything before it is the
 *     response. A `PSHOSTERR:` prefix is surfaced as a rejection so the caller
 *     falls back to its one-shot path.
 *
 * Requests are serialized through a single promise chain — one in flight at a
 * time over the one pipe. That is fine: each request is now sub-second, so even
 * a handful of dirty-region captures per turn complete far faster than a single
 * cold spawn used to.
 *
 * Disable entirely with `COMPUTERUSE_PS_HOST=0`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { psSpawnTimeoutMs } from "./windows-timeouts.js";

/** Per-process nonce so request tokens can never collide with script output. */
const NONCE = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
let seq = 0;

/**
 * Startup budget for the (one-time) cold spawn + warmup ping. Raisable on
 * extreme Defender-heavy hosts via `ELIZA_COMPUTERUSE_PS_TIMEOUT_MS` — resolved
 * through {@link psSpawnTimeoutMs} at each use so it tracks the same floor as
 * the per-request capture/clipboard budgets.
 */
const STARTUP_TIMEOUT_BASE_MS = 25_000;
const startupTimeoutMs = (): number =>
  psSpawnTimeoutMs(STARTUP_TIMEOUT_BASE_MS);
/** After this many consecutive startup failures, stop trying for the session. */
const MAX_START_FAILURES = 2;

let host: ChildProcessWithoutNullStreams | null = null;
let starting: Promise<void> | null = null;
let startFailures = 0;
let loopScriptPath: string | null = null;
// Gate against respawning after an owner-initiated dispose. `shutdownPsHost()`
// (timeout / test cleanup) leaves this true so the next call can respawn;
// `disposePsHost()` (service stop) sets it false so a fire-and-forget warm
// continuation can't resurrect a host after the service has stopped.
let spawnAllowed = true;
let stdoutBuf = "";
let stderrRing = "";
let pending: {
  token: string;
  resolve: (out: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/** Serialization chain — at most one request is in flight on the host. */
let chain: Promise<unknown> = Promise.resolve();

// The PowerShell server loop. Reads `<token> <base64>` lines from stdin, runs
// the decoded script in a child scope, echoes the token to delimit the reply.
// UTF-8 output so JSON / clipboard text round-trips. Pre-loads the assemblies
// capture needs so per-request scripts stay lean (re-`Add-Type` is harmless
// anyway). `$ErrorActionPreference='Stop'` makes failures terminate into our
// try/catch instead of leaking to stderr mid-stream.
const SERVER_LOOP = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "try { Add-Type -AssemblyName System.Windows.Forms,System.Drawing } catch {}",
  "while ($true) {",
  "  $line=[Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line.Length -eq 0) { continue }",
  "  $sp=$line.IndexOf(' ')",
  "  if ($sp -lt 0) { continue }",
  "  $tok=$line.Substring(0,$sp)",
  "  $b64=$line.Substring($sp+1)",
  "  try {",
  "    $script=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))",
  "    & ([ScriptBlock]::Create($script))",
  "  } catch {",
  "    [Console]::Out.Write('PSHOSTERR:'+$_.Exception.Message)",
  "  }",
  "  [Console]::Out.Write($tok)",
  "  [Console]::Out.Flush()",
  "}",
].join("\n");

/**
 * Whether the warm host is usable on this platform / configuration. Callers
 * should check this before attempting {@link runPsHost} and skip straight to
 * their one-shot path when false.
 */
export function psHostAvailable(): boolean {
  if (platform() !== "win32") return false;
  if (process.env.COMPUTERUSE_PS_HOST === "0") return false;
  if (startFailures >= MAX_START_FAILURES) return false;
  return true;
}

function onStdout(chunk: Buffer): void {
  stdoutBuf += chunk.toString("utf8");
  if (!pending) return;
  const idx = stdoutBuf.indexOf(pending.token);
  if (idx === -1) return;
  const out = stdoutBuf.slice(0, idx);
  stdoutBuf = stdoutBuf.slice(idx + pending.token.length);
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  if (out.startsWith("PSHOSTERR:")) {
    p.reject(
      new Error(`ps-host script error: ${out.slice("PSHOSTERR:".length)}`),
    );
  } else {
    p.resolve(out);
  }
}

function onExit(): void {
  host = null;
  starting = null;
  stdoutBuf = "";
  if (pending) {
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.reject(new Error("ps-host exited unexpectedly"));
  }
}

/** Tear the host down (test cleanup / unrecoverable state). */
export function shutdownPsHost(): void {
  if (host) {
    try {
      host.stdin.end();
    } catch {
      // error-policy:J6 best-effort teardown; the host is being discarded.
    }
    try {
      host.kill();
    } catch {
      // error-policy:J6 best-effort teardown; the host is being discarded.
    }
  }
  if (loopScriptPath) {
    try {
      unlinkSync(loopScriptPath);
    } catch {
      // error-policy:J6 best-effort teardown of the loop script temp file.
    }
    loopScriptPath = null;
  }
  onExit();
}

async function ensureHost(): Promise<void> {
  if (host) return;
  // Owner disposed the host (service stopped); refuse to resurrect it from a
  // late fire-and-forget continuation. Callers fall back to one-shot spawns.
  if (!spawnAllowed) throw new Error("ps-host disposed");
  if (starting) return starting;
  starting = (async () => {
    // Write the server loop to disk and run it with `-File` so stdin stays free
    // for the loop's ReadLine (see module header).
    const scriptPath = join(
      tmpdir(),
      `computeruse-pshost-${process.pid}-${seq}.ps1`,
    );
    writeFileSync(scriptPath, SERVER_LOOP, "utf8");
    loopScriptPath = scriptPath;
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        // `-File` is subject to the machine ExecutionPolicy; Bypass keeps the
        // loop script runnable on locked-down hosts (default policy disables
        // running .ps1 files).
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    child.stdout.on("data", onStdout);
    child.stderr.on("data", (c: Buffer) => {
      stderrRing = (stderrRing + c.toString("utf8")).slice(-2048);
    });
    // Swallow stdin pipe errors (EPIPE when the host dies between requests).
    // Without this listener Node throws the 'error' as an uncaught exception
    // and crashes the whole process — defeating the transparent-fallback
    // contract. The dead pipe surfaces via onExit → a normal rejection instead.
    child.stdin.on("error", () => {});
    // Bind exit/error to THIS child: a previously-killed host's late 'exit'
    // event must not tear down a freshly respawned host or reject its pending
    // request. Stale events are ignored.
    const onChildGone = () => {
      if (host !== child) return;
      onExit();
    };
    child.once("exit", onChildGone);
    child.once("error", onChildGone);
    host = child;
    // Warmup ping — proves the loop is reading and the process is hot.
    await sendRaw("$null", startupTimeoutMs());
  })();
  try {
    await starting;
    startFailures = 0;
  } catch (err) {
    startFailures += 1;
    shutdownPsHost();
    throw err;
  } finally {
    starting = null;
  }
}

/** Low-level: assumes host is alive; sends one framed request. */
function sendRaw(script: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!host) {
      reject(new Error("ps-host not running"));
      return;
    }
    seq += 1;
    const token = `<<PSEOR:${NONCE}:${seq}>>`;
    const b64 = Buffer.from(script, "utf8").toString("base64");
    const timer = setTimeout(() => {
      if (pending && pending.token === token) pending = null;
      // A wedged host is unrecoverable for this protocol — kill so the next
      // call respawns fresh rather than reading a stale, misframed stream.
      shutdownPsHost();
      reject(
        new Error(
          `ps-host timeout after ${timeoutMs}ms${stderrRing ? ` (stderr: ${stderrRing.trim().slice(-200)})` : ""}`,
        ),
      );
    }, timeoutMs);
    pending = { token, resolve, reject, timer };
    try {
      host.stdin.write(`${token} ${b64}\n`);
    } catch (err) {
      // error-policy:J1 promise boundary — a synchronous write failure (e.g.
      // dead pipe) surfaces as a rejection so the caller falls back to a
      // one-shot spawn, and the host is torn down so the next call respawns.
      clearTimeout(timer);
      pending = null;
      shutdownPsHost();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Run a PowerShell script in the warm host and resolve with its stdout (UTF-8).
 * Serialized against other in-flight requests. Rejects (so the caller can fall
 * back to a one-shot spawn) on host-start failure, script error, timeout, or
 * unexpected host exit.
 *
 * @param script    PowerShell source. Runs in a child scope; assemblies
 *                  `System.Windows.Forms` + `System.Drawing` are preloaded.
 * @param timeoutMs Per-request budget.
 */
export function runPsHost(script: string, timeoutMs: number): Promise<string> {
  const task = async (): Promise<string> => {
    await ensureHost();
    return sendRaw(script, timeoutMs);
  };
  const run = chain.then(task, task);
  // error-policy:J5 the rejection is observed by the caller of runPsHost()
  // (which receives `run` itself); this catch only keeps the serialization
  // chain alive so one failed request cannot wedge every later request.
  chain = run.catch(() => {});
  return run;
}

/**
 * Best-effort pre-warm: pay the one-time cold spawn during service init instead
 * of on the first capture/clipboard call. Never rejects — if the host can't
 * start, callers transparently fall back to one-shot spawns.
 */
export function warmPsHost(): Promise<void> {
  // Re-enable spawning: an explicit warm is a fresh intent to use the host
  // (e.g. a service (re)start after a prior dispose).
  spawnAllowed = true;
  if (!psHostAvailable()) return Promise.resolve();
  // error-policy:J5 the start failure is observed inside ensureHost (which
  // latches startFailures until the host is disabled); every real consumer
  // falls back to a one-shot spawn whose failure surfaces to its caller.
  // This handler only upholds the documented never-rejects warm contract.
  return runPsHost("$null", startupTimeoutMs()).then(
    () => {},
    () => {},
  );
}

/**
 * Owner-initiated dispose (service stop). Unlike {@link shutdownPsHost} (which
 * leaves the host respawnable for the next call — used by the timeout path),
 * this latches spawning OFF so an in-flight fire-and-forget warm continuation
 * cannot resurrect a powershell.exe after the service has stopped. A later
 * {@link warmPsHost} re-enables it.
 */
export function disposePsHost(): void {
  spawnAllowed = false;
  shutdownPsHost();
}

/** Test-only: reset failure latch so a fresh attempt can be made. */
export function __resetPsHostFailures(): void {
  startFailures = 0;
}

// Best-effort cleanup so we don't leak a powershell.exe on process exit.
process.once("exit", () => {
  if (host) {
    try {
      host.kill();
    } catch {
      // error-policy:J6 best-effort teardown on process exit; nothing can
      // observe a failure here.
    }
  }
});
