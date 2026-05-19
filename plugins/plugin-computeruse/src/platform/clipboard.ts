/**
 * Cross-platform clipboard read / write.
 *
 * Per-platform tool dependencies (install with the listed package manager when
 * not already present):
 *   - Linux Wayland : `wl-clipboard` (apt: `wl-clipboard`, dnf: `wl-clipboard`,
 *                     pacman: `wl-clipboard`). Provides `wl-copy` / `wl-paste`.
 *                     Selected when `WAYLAND_DISPLAY` is set.
 *   - Linux X11     : `xclip` (apt: `xclip`, dnf: `xclip`, pacman: `xclip`).
 *                     Used when not on Wayland.
 *   - macOS         : `pbcopy` / `pbpaste` (built-in, no install needed).
 *   - Windows       : PowerShell `Get-Clipboard` / `Set-Clipboard` (built-in
 *                     on Windows 10+).
 *
 * If the required tool is missing on Linux, callers receive a typed
 * `ClipboardUnavailableError` with the install hint embedded in `.message`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { commandExists, currentPlatform } from "./helpers.js";

const CLIPBOARD_TIMEOUT_MS = 5_000;
const CLIPBOARD_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB cap

export class ClipboardUnavailableError extends Error {
  readonly tool: string;
  constructor(tool: string, hint: string) {
    super(`Clipboard tool "${tool}" not found on PATH. ${hint}`);
    this.name = "ClipboardUnavailableError";
    this.tool = tool;
  }
}

type LinuxBackend = "wayland" | "x11";

function detectLinuxBackend(): LinuxBackend {
  const wayland = (process.env.WAYLAND_DISPLAY ?? "").trim();
  if (wayland.length > 0) return "wayland";
  return "x11";
}

interface ClipboardCommand {
  command: string;
  args: readonly string[];
}

interface ClipboardPlan {
  read: ClipboardCommand;
  write: ClipboardCommand;
}

function pickPlan(): ClipboardPlan {
  const os = currentPlatform();
  if (os === "darwin") {
    return {
      read: { command: "pbpaste", args: [] },
      write: { command: "pbcopy", args: [] },
    };
  }
  if (os === "win32") {
    return {
      read: {
        command: "powershell",
        args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
      },
      write: {
        command: "powershell",
        args: ["-NoProfile", "-Command", "$input | Set-Clipboard"],
      },
    };
  }
  // Linux: Wayland-first, then X11.
  if (detectLinuxBackend() === "wayland") {
    if (!commandExists("wl-paste") || !commandExists("wl-copy")) {
      throw new ClipboardUnavailableError(
        "wl-clipboard",
        "Install wl-clipboard (apt/dnf/pacman package: wl-clipboard) to enable clipboard on Wayland.",
      );
    }
    return {
      read: { command: "wl-paste", args: ["--no-newline"] },
      write: { command: "wl-copy", args: [] },
    };
  }
  if (!commandExists("xclip")) {
    throw new ClipboardUnavailableError(
      "xclip",
      "Install xclip (apt/dnf/pacman package: xclip) to enable clipboard on X11.",
    );
  }
  return {
    read: { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    write: { command: "xclip", args: ["-selection", "clipboard", "-i"] },
  };
}

export async function readClipboard(): Promise<string> {
  const plan = pickPlan();
  // encoding: "utf-8" forces the typed return to string.
  const out = execFileSync(plan.read.command, [...plan.read.args], {
    timeout: CLIPBOARD_TIMEOUT_MS,
    maxBuffer: CLIPBOARD_MAX_BYTES,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out;
}

export async function writeClipboard(text: string): Promise<void> {
  if (typeof text !== "string") {
    throw new TypeError("writeClipboard: text must be a string");
  }
  if (Buffer.byteLength(text, "utf-8") > CLIPBOARD_MAX_BYTES) {
    throw new RangeError(
      `writeClipboard: payload exceeds ${CLIPBOARD_MAX_BYTES} bytes`,
    );
  }
  const plan = pickPlan();
  const result = spawnSync(plan.write.command, [...plan.write.args], {
    input: text,
    timeout: CLIPBOARD_TIMEOUT_MS,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    // encoding: "utf-8" forces stderr to string when present.
    const stderr = result.stderr ?? "";
    throw new Error(
      `Clipboard write failed (${plan.write.command} exit ${result.status}): ${stderr.trim()}`,
    );
  }
}

/** Internal hook for unit tests — re-exported for parity with helpers.ts. */
export const __testing = {
  detectLinuxBackend,
  pickPlan,
};
