/** Native, explicit opt-in enrollment into the managed Headscale network. */

import { type ChildProcess, execFile, spawn } from "node:child_process";
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
  leave(
    input: Pick<RemoteTargetManagedNetworkEnrollment, "hostname">,
  ): Promise<void>;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    shell: false;
    stdio: ["ignore", "ignore", "ignore"];
  },
) => ChildProcess;

type InspectDaemon = (executable: string) => Promise<void>;

type ReadDaemonStatus = (executable: string) => Promise<string>;

function assertVacantTailscaleStatus(rawStatus: string): void {
  let status: unknown;
  try {
    status = JSON.parse(rawStatus);
  } catch (cause) {
    // error-policy:J3 an unreadable daemon response cannot authorize a
    // control-server switch on the user's system Tailscale profile.
    throw new Error("Tailscale status could not be verified safely.", {
      cause,
    });
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    throw new Error("Tailscale status could not be verified safely.");
  }
  const value = status as Record<string, unknown>;
  const backendState = value.BackendState;
  const currentTailnet = value.CurrentTailnet;
  const self = value.Self;
  const addresses = value.TailscaleIPs;
  const hasAddresses = Array.isArray(addresses) && addresses.length > 0;
  const vacantState =
    backendState === "NeedsLogin" ||
    backendState === "NoState" ||
    backendState === "Stopped";
  if (
    !vacantState ||
    (currentTailnet !== undefined && currentTailnet !== null) ||
    (self !== undefined && self !== null) ||
    hasAddresses
  ) {
    throw new Error(
      "Managed enrollment cannot replace an existing Tailscale tailnet. Disconnect and remove the existing local profile, or use a dedicated device.",
    );
  }
}

const inspectVacantSystemDaemon: InspectDaemon = (executable) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      ["status", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // error-policy:J2 status failure is wrapped because an unknown
          // daemon profile must fail closed before any `tailscale up`.
          reject(
            new Error("Tailscale status could not be verified safely.", {
              cause: error,
            }),
          );
          return;
        }
        try {
          assertVacantTailscaleStatus(stdout);
          resolve();
        } catch (cause) {
          // error-policy:J2 preserve the typed preflight cause at the native
          // command boundary without running a mutating CLI command.
          reject(cause);
        }
      },
    );
  });

const readSystemDaemonStatus: ReadDaemonStatus = (executable) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      ["status", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          // error-policy:J2 status failure is wrapped because logout must
          // never target an unknown system Tailscale profile.
          reject(
            new Error("Managed Tailscale membership could not be verified.", {
              cause: error,
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });

function assertManagedTailscaleStatus(
  rawStatus: string,
  hostname: string,
): void {
  let status: unknown;
  try {
    status = JSON.parse(rawStatus);
  } catch (cause) {
    // error-policy:J3 an unreadable daemon response cannot authorize logout.
    throw new Error("Managed Tailscale membership could not be verified.", {
      cause,
    });
  }
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    throw new Error("Managed Tailscale membership could not be verified.");
  }
  const value = status as Record<string, unknown>;
  const self = value.Self;
  const observedHostname =
    typeof self === "object" && self !== null && !Array.isArray(self)
      ? Reflect.get(self, "HostName")
      : undefined;
  const escapedHostname = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const collisionHostname = new RegExp(`^${escapedHostname}-[a-z0-9]{8}$`);
  if (
    value.BackendState !== "Running" ||
    typeof observedHostname !== "string" ||
    (observedHostname !== hostname && !collisionHostname.test(observedHostname))
  ) {
    throw new Error(
      "The active Tailscale profile is not the managed Eliza membership; it was left unchanged.",
    );
  }
}

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
      // error-policy:J3 an unavailable fixed candidate is an explicit miss;
      // resolution continues without consulting PATH or a shell.
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
    private readonly inspectDaemon: InspectDaemon = inspectVacantSystemDaemon,
    private readonly readDaemonStatus: ReadDaemonStatus = readSystemDaemonStatus,
  ) {}

  private async run(
    executable: string,
    args: readonly string[],
    failureMessage: string,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(executable, args, {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
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
        finish(new Error(`${failureMessage} timed out.`));
      }, JOIN_TIMEOUT_MS);
      child.once("error", (cause) =>
        finish(new Error(failureMessage, { cause })),
      );
      child.once("close", (code) =>
        finish(code === 0 ? undefined : new Error(failureMessage)),
      );
    });
  }

  async join(input: RemoteTargetManagedNetworkEnrollment): Promise<void> {
    validateEnrollment(input, this.now());
    const executable = await this.resolveExecutable();
    await this.inspectDaemon(executable);
    const temporaryDirectory = await fs.mkdtemp(
      path.join(this.temporaryRoot, "eliza-managed-network-"),
    );
    await fs.chmod(temporaryDirectory, 0o700);
    const authKeyPath = path.join(temporaryDirectory, "auth-key");
    let primaryFailure: unknown;
    let joined = false;
    try {
      await fs.writeFile(authKeyPath, input.authKey, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.run(
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
        "Tailscale rejected managed enrollment. Existing tailnet state was not reset.",
      );
      joined = true;
    } catch (cause) {
      // error-policy:J1 the native enrollment boundary preserves the primary
      // mutation failure while still attempting secret-file teardown below.
      primaryFailure = cause;
    }
    let teardownFailure: unknown;
    try {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    } catch (cause) {
      // error-policy:J6 secret-file teardown is best effort but must remain
      // visible and must never replace the primary enrollment failure.
      teardownFailure = cause;
    }
    if (joined && teardownFailure !== undefined) {
      try {
        await this.leave({ hostname: input.hostname });
      } catch (membershipCleanupFailure) {
        throw new AggregateError(
          [teardownFailure, membershipCleanupFailure],
          "Managed enrollment joined successfully, but local cleanup failed.",
          { cause: teardownFailure },
        );
      }
    }
    if (primaryFailure !== undefined && teardownFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, teardownFailure],
        "Managed enrollment failed and its temporary key cleanup also failed.",
        { cause: primaryFailure },
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (teardownFailure !== undefined) throw teardownFailure;
  }

  async leave(
    input: Pick<RemoteTargetManagedNetworkEnrollment, "hostname">,
  ): Promise<void> {
    if (!HOSTNAME_PATTERN.test(input.hostname)) {
      throw new Error("Managed network hostname is invalid.");
    }
    const executable = await this.resolveExecutable();
    const rawStatus = await this.readDaemonStatus(executable);
    try {
      assertVacantTailscaleStatus(rawStatus);
      return;
    } catch {
      // error-policy:J3 only a verified app-owned managed membership may
      // proceed to logout; a vacant daemon makes teardown idempotent.
    }
    assertManagedTailscaleStatus(rawStatus, input.hostname);
    await this.run(
      executable,
      ["logout"],
      "Tailscale could not leave the managed network",
    );
  }
}

export const remoteTargetManagedNetworkInternals = {
  HOSTNAME_PATTERN,
  JOIN_TIMEOUT_MS,
  executableCandidates,
  assertVacantTailscaleStatus,
  assertManagedTailscaleStatus,
  validateEnrollment,
};
