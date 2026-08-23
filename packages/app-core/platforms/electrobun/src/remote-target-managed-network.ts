/** Native, explicit opt-in enrollment into the managed Headscale network. */

import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const JOIN_TIMEOUT_MS = 45_000;
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface RemoteTargetManagedNetworkEnrollment {
  loginServer: string;
  authKey: string;
  hostname: string;
  expiresAt: number;
}

export interface RemoteTargetManagedNetworkJoiner {
  join(input: RemoteTargetManagedNetworkEnrollment): Promise<void>;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "ignore"];
  },
) => ChildProcess;

function validateEnrollment(
  input: RemoteTargetManagedNetworkEnrollment,
  now = Date.now(),
): void {
  const loginServer = new URL(input.loginServer);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    loginServer.hostname.toLowerCase(),
  );
  if (
    (loginServer.protocol !== "https:" &&
      !(loginServer.protocol === "http:" && loopback)) ||
    loginServer.username ||
    loginServer.password ||
    loginServer.search ||
    loginServer.hash ||
    loginServer.pathname.replace(/\/+$/, "")
  ) {
    throw new Error("Managed network login server is invalid.");
  }
  if (!HOSTNAME_PATTERN.test(input.hostname)) {
    throw new Error("Managed network hostname is invalid.");
  }
  if (
    typeof input.authKey !== "string" ||
    input.authKey.length < 16 ||
    input.authKey.length > 4_096 ||
    /[\r\n\0]/.test(input.authKey)
  ) {
    throw new Error("Managed network enrollment key is invalid.");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new Error("Managed network enrollment key has expired.");
  }
}

function executableCandidates(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    return [
      ...(programFiles && !/[\r\n\0]/.test(programFiles)
        ? [path.win32.join(programFiles, "Tailscale", "tailscale.exe")]
        : []),
      "C:\\Program Files\\Tailscale\\tailscale.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
    ];
  }
  return ["/usr/bin/tailscale", "/usr/local/bin/tailscale"];
}

async function resolveTailscaleExecutable(): Promise<string> {
  for (const candidate of executableCandidates()) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through fixed, non-shell executable locations.
    }
  }
  throw new Error(
    "Tailscale is not installed. Install and start Tailscale, then retry managed enrollment.",
  );
}

export class TailscaleCliManagedNetworkJoiner
  implements RemoteTargetManagedNetworkJoiner
{
  constructor(
    private readonly resolveExecutable: () => Promise<string> = resolveTailscaleExecutable,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly temporaryRoot = os.tmpdir(),
    private readonly now: () => number = Date.now,
  ) {}

  async join(input: RemoteTargetManagedNetworkEnrollment): Promise<void> {
    validateEnrollment(input, this.now());
    const executable = await this.resolveExecutable();
    const temporaryDirectory = await fs.mkdtemp(
      path.join(this.temporaryRoot, "eliza-managed-network-"),
    );
    await fs.chmod(temporaryDirectory, 0o700);
    const authKeyPath = path.join(temporaryDirectory, "auth-key");
    try {
      await fs.writeFile(authKeyPath, input.authKey, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await new Promise<void>((resolve, reject) => {
        const child = this.spawnProcess(
          executable,
          [
            "up",
            `--login-server=${input.loginServer}`,
            `--auth-key=file:${authKeyPath}`,
            `--hostname=${input.hostname}`,
            "--accept-dns=false",
            "--accept-routes=false",
            "--shields-up",
            "--timeout=30s",
          ],
          { shell: false, stdio: ["ignore", "ignore", "ignore"] },
        );
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          finish(new Error("Managed network enrollment timed out."));
        }, JOIN_TIMEOUT_MS);
        child.once("error", (cause) =>
          finish(
            new Error("Tailscale could not start managed enrollment.", {
              cause,
            }),
          ),
        );
        child.once("close", (code) =>
          finish(
            code === 0
              ? undefined
              : new Error(
                  "Tailscale rejected managed enrollment. Existing tailnet state was not reset.",
                ),
          ),
        );
      });
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export const remoteTargetManagedNetworkInternals = {
  HOSTNAME_PATTERN,
  JOIN_TIMEOUT_MS,
  executableCandidates,
  validateEnrollment,
};
