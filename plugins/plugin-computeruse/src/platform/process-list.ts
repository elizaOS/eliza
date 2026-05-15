/**
 * Cross-platform process listing.
 *
 * The WS6 scene-builder joins running processes with windows to produce the
 * `apps[]` field of a Scene. The contract is intentionally minimal — pid,
 * executable/display name, and a best-effort foreground flag if cheap to
 * obtain. Anything richer (memory, cpu, parent pid) is out of scope here
 * because the scene-builder runs every active-poll frame and must stay
 * cheap.
 *
 * Per-OS source:
 *   - Linux  : `/proc/<pid>/comm` and `/proc/<pid>/status`. Pure FS read,
 *              no shell out. ~5ms for 300 processes.
 *   - macOS  : `ps -axo pid=,comm=` — built-in BSD ps.
 *   - Windows: PowerShell `Get-Process | Select Id, ProcessName`.
 *   - Android: stub returning `[]` — the JS contract for `UsageStatsManager`
 *              is owned by WS8's native side. We expose the function shape so
 *              the scene-builder doesn't have to branch.
 *
 * Failure semantics:
 *   - A single un-readable process is skipped, not propagated.
 *   - A complete enumeration failure returns `[]` and the scene-builder logs
 *     once per platform-mode at warn.
 */

import { execFileSync, execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { currentPlatform } from "./helpers.js";

export interface ProcessInfo {
  pid: number;
  name: string;
}

export function listProcesses(): ProcessInfo[] {
  const os = currentPlatform();
  if (os === "linux") return listLinux();
  if (os === "darwin") return listDarwin();
  if (os === "win32") return listWindows();
  return [];
}

function listLinux(): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (!Number.isFinite(pid)) continue;
    let name = "";
    try {
      // `comm` is the 15-char truncated executable basename. Good enough for
      // join-with-windows; a longer name (cmdline arg0 basename) is overkill.
      name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      continue;
    }
    if (!name) continue;
    out.push({ pid, name });
  }
  return out;
}

function listDarwin(): ProcessInfo[] {
  try {
    const text = execFileSync("ps", ["-axco", "pid=,comm="], {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parsePsOutput(text);
  } catch {
    try {
      // Fallback: BSD ps without `-c` (gives full path in comm).
      const text = execFileSync("ps", ["-axo", "pid=,comm="], {
        timeout: 4000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parsePsOutput(text);
    } catch {
      return [];
    }
  }
}

export function parsePsOutput(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number.parseInt(m[1] ?? "0", 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const rawName = (m[2] ?? "").trim();
    if (!rawName) continue;
    // For `ps -axo pid=,comm=` without `-c` the comm column holds an absolute
    // path. We strip to the basename so the scene-builder's join key matches
    // the AppleScript window enumerator's `name of proc`.
    const name = rawName.split("/").pop() ?? rawName;
    out.push({ pid, name });
  }
  return out;
}

function listWindows(): ProcessInfo[] {
  try {
    const text = execSync(
      'powershell -NoProfile -Command "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress"',
      { timeout: 8000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseWindowsProcessJson(text);
  } catch {
    return [];
  }
}

interface WinProcessRow {
  Id?: number;
  ProcessName?: string;
}

export function parseWindowsProcessJson(text: string): ProcessInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const items: WinProcessRow[] = Array.isArray(raw)
    ? (raw as WinProcessRow[])
    : [raw as WinProcessRow];
  const out: ProcessInfo[] = [];
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const pid = Number(row.Id);
    const name = typeof row.ProcessName === "string" ? row.ProcessName : "";
    if (!Number.isFinite(pid) || pid <= 0 || !name) continue;
    out.push({ pid, name });
  }
  return out;
}
