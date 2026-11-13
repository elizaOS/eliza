/**
 * Owns short-lived clipboard leases for credential delivery. Expiry clears only
 * the value this process wrote; later user copies are preserved. Secret bytes
 * never appear in errors or logs and are erased when a lease ends.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { logger } from "@elizaos/core";

export class CredentialClipboardError extends Error {
  readonly code = "CREDENTIAL_CLIPBOARD_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "CredentialClipboardError";
  }
}

const execFileAsync = promisify(execFile);
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

type Command = { binary: string; args: string[] };

function bindCommand(command: Command, env: NodeJS.ProcessEnv): Command {
  const setting = (name: string) => {
    const key =
      process.platform === "win32"
        ? Object.keys(env)
            .sort()
            .find((key) => key.toUpperCase() === name)
        : name;
    return key === undefined ? undefined : env[key];
  };
  const extensions =
    process.platform === "win32" && !path.extname(command.binary)
      ? (setting("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((extension) => extension.trim())
          .filter(Boolean)
      : [""];
  const directories = (
    setting("PATH") ?? (process.platform === "win32" ? "" : "/usr/bin:/bin")
  ).split(path.delimiter);
  if (process.platform === "win32") directories.unshift(process.cwd());
  const candidates =
    path.isAbsolute(command.binary) || command.binary.includes(path.sep)
      ? [path.resolve(command.binary)]
      : directories.flatMap((directory) =>
          extensions.map((extension) =>
            path.resolve(directory, `${command.binary}${extension}`),
          ),
        );
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { ...command, binary: realpathSync(candidate) };
    } catch {
      // error-policy:J3 Missing or non-executable candidates are PATH misses.
    }
  }
  throw new CredentialClipboardError("Credential clipboard is unavailable.");
}

function commands(): { read: Command; write: Command } {
  if (process.platform === "darwin") {
    return {
      read: { binary: "pbpaste", args: [] },
      write: { binary: "pbcopy", args: [] },
    };
  }
  if (process.platform === "win32") {
    return {
      read: {
        binary: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::Write((Get-Clipboard -Raw))",
        ],
      },
      write: {
        binary: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
      },
    };
  }
  if (process.env.WAYLAND_DISPLAY) {
    return {
      read: { binary: "wl-paste", args: ["--no-newline"] },
      write: {
        binary: "wl-copy",
        args: ["--type", "text/plain;charset=utf-8"],
      },
    };
  }
  return {
    read: { binary: "xclip", args: ["-selection", "clipboard", "-out"] },
    write: { binary: "xclip", args: ["-selection", "clipboard", "-in"] },
  };
}

async function write(
  command: Command,
  value: Buffer,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      stdio: ["pipe", "ignore", "ignore"],
      env,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new CredentialClipboardError("Credential clipboard is unavailable."),
      );
    });
    child.stdin.on("error", () => {
      // error-policy:J5 The child's exit/error handler reports the failed write.
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else
        reject(
          new CredentialClipboardError("Credential clipboard write failed."),
        );
    });
    child.stdin.end(value);
  });
}

/** Consumes the supplied buffer, including on failure. Returns a manual expiry hook. */
export async function leaseCredentialClipboard(
  value: Buffer,
  ttlMilliseconds: number,
): Promise<() => Promise<void>> {
  if (
    !Number.isSafeInteger(ttlMilliseconds) ||
    ttlMilliseconds <= 0 ||
    value.length > MAX_CREDENTIAL_BYTES
  ) {
    value.fill(0);
    throw new CredentialClipboardError("Invalid credential clipboard lease.");
  }
  // A lease retains the admitted command paths and display environment even
  // if a later task changes PATH or selects another clipboard backend.
  const env = { ...process.env };
  let clipboard: ReturnType<typeof commands>;
  try {
    const selected = commands();
    clipboard = {
      read: bindCommand(selected.read, env),
      write: bindCommand(selected.write, env),
    };
  } catch (error) {
    value.fill(0);
    throw error;
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const onExit = () => {
    try {
      const current = execFileSync(clipboard.read.binary, clipboard.read.args, {
        timeout: 1_000,
        maxBuffer: MAX_CREDENTIAL_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      });
      const owned = current.equals(value);
      current.fill(0);
      if (owned)
        execFileSync(clipboard.write.binary, clipboard.write.args, {
          input: Buffer.alloc(0),
          timeout: 1_000,
          stdio: ["pipe", "ignore", "ignore"],
          env,
        });
    } catch {
      // error-policy:J6 Process-exit cleanup cannot recover an unavailable clipboard.
    } finally {
      value.fill(0);
    }
  };
  const expire = async () => {
    if (expired) return;
    expired = true;
    clearTimeout(timer);
    process.removeListener("exit", onExit);
    try {
      const { stdout } = await execFileAsync(
        clipboard.read.binary,
        clipboard.read.args,
        {
          encoding: "buffer",
          timeout: 5_000,
          maxBuffer: MAX_CREDENTIAL_BYTES,
          env,
        },
      );
      const owned = stdout.equals(value);
      stdout.fill(0);
      if (owned) await write(clipboard.write, Buffer.alloc(0), env);
    } catch {
      // error-policy:J2 Never retain clipboard subprocess output in the error.
      throw new CredentialClipboardError(
        "Could not clear the credential clipboard; clear it manually.",
      );
    } finally {
      value.fill(0);
    }
  };
  try {
    await write(clipboard.write, value, env);
  } catch {
    // error-policy:J2 Clipboard failures must not carry secret input or subprocess output.
    value.fill(0);
    throw new CredentialClipboardError(
      "Could not copy the credential to the clipboard.",
    );
  }
  process.once("exit", onExit);
  timer = setTimeout(() => {
    void expire().catch(() => {
      // error-policy:J7 Report a constant diagnostic without secret subprocess output.
      logger.warn(
        "[CredentialClipboard] Expiry failed; clear the clipboard manually.",
      );
    });
  }, ttlMilliseconds);
  timer.unref();
  return expire;
}
