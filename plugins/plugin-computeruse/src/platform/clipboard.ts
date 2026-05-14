import { spawnSync } from "node:child_process";
import { currentPlatform, commandExists, type PlatformOS } from "./helpers.js";

const CLIPBOARD_TIMEOUT_MS = 5000;

type ClipboardCommand = {
  command: string;
  args: string[];
};

type ClipboardDeps = {
  osName: PlatformOS;
  commandExists: (command: string) => boolean;
};

function clipboardDeps(): ClipboardDeps {
  return {
    osName: currentPlatform(),
    commandExists,
  };
}

function getCommand(deps: ClipboardDeps): ClipboardCommand {
  switch (deps.osName) {
    case "darwin":
      return { command: "pbpaste", args: [] };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))",
        ],
      };
    case "linux":
      if (deps.commandExists("wl-paste")) {
        return { command: "wl-paste", args: [] };
      }
      if (deps.commandExists("xclip")) {
        return { command: "xclip", args: ["-selection", "clipboard", "-out"] };
      }
      if (deps.commandExists("xsel")) {
        return { command: "xsel", args: ["--clipboard", "--output"] };
      }
      throw new Error("No Linux clipboard command found (install wl-clipboard, xclip, or xsel)");
  }
}

function setCommand(deps: ClipboardDeps): ClipboardCommand {
  switch (deps.osName) {
    case "darwin":
      return { command: "pbcopy", args: [] };
    case "win32":
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
        ],
      };
    case "linux":
      if (deps.commandExists("wl-copy")) {
        return { command: "wl-copy", args: [] };
      }
      if (deps.commandExists("xclip")) {
        return { command: "xclip", args: ["-selection", "clipboard", "-in"] };
      }
      if (deps.commandExists("xsel")) {
        return { command: "xsel", args: ["--clipboard", "--input"] };
      }
      throw new Error("No Linux clipboard command found (install wl-clipboard, xclip, or xsel)");
  }
}

function runClipboardCommand(
  cmd: ClipboardCommand,
  input?: string,
): { stdout: string } {
  const result = spawnSync(cmd.command, cmd.args, {
    input,
    encoding: "utf8",
    timeout: CLIPBOARD_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      stderr || `Clipboard command failed: ${cmd.command} exited ${result.status}`,
    );
  }

  return { stdout: result.stdout ?? "" };
}

export function describeClipboardCommands(
  deps: ClipboardDeps = clipboardDeps(),
): { get: ClipboardCommand; set: ClipboardCommand } {
  return {
    get: getCommand(deps),
    set: setCommand(deps),
  };
}

export async function getClipboardText(): Promise<string> {
  return runClipboardCommand(getCommand(clipboardDeps())).stdout;
}

export async function setClipboardText(text: string): Promise<void> {
  if (typeof text !== "string") {
    throw new Error("text is required for clipboard set");
  }
  runClipboardCommand(setCommand(clipboardDeps()), text);
}
