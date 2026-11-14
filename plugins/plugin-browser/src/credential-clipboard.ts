/**
 * Owns short-lived clipboard leases for credential delivery. Expiry clears only
 * the value this process wrote; later user copies are preserved. Secret bytes
 * never appear in errors or logs and are erased when a lease ends.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
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

async function write(command: Command, value: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      stdio: ["pipe", "ignore", "ignore"],
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
  const clipboard = commands();
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const onExit = () => {
    try {
      const current = execFileSync(clipboard.read.binary, clipboard.read.args, {
        timeout: 1_000,
        maxBuffer: MAX_CREDENTIAL_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const owned = current.equals(value);
      current.fill(0);
      if (owned)
        execFileSync(clipboard.write.binary, clipboard.write.args, {
          input: Buffer.alloc(0),
          timeout: 1_000,
          stdio: ["pipe", "ignore", "ignore"],
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
        { encoding: "buffer", timeout: 5_000, maxBuffer: MAX_CREDENTIAL_BYTES },
      );
      const owned = stdout.equals(value);
      stdout.fill(0);
      if (owned) await write(clipboard.write, Buffer.alloc(0));
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
    await write(clipboard.write, value);
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
