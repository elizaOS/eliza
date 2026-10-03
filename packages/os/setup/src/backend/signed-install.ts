import { spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { signedInstallerPath } from "./signed-release";

export class SignedInstallError extends Error {
  readonly code = "ELIZAOS_SIGNED_INSTALL_FAILED";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SignedInstallError";
  }
}

export interface SignedInstallInput {
  serial: string;
  artifactDir: string;
  manifestPath: string;
  subjectSha256: string;
  toolDir: string;
  healthTokenFile: string;
  stateDirectory: string;
  wipe: boolean;
}

/** The canonical executor owns device locks, transitions, writes and health checks. */
export async function executeSignedInstall(
  input: SignedInstallInput,
): Promise<string> {
  if (process.platform !== "linux") {
    throw new SignedInstallError(
      "Signed installation currently requires a Linux host.",
    );
  }
  if (!input.healthTokenFile) {
    throw new SignedInstallError(
      "Configure the private Android health-token file before installation.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.subjectSha256)) {
    throw new SignedInstallError(
      "Authenticated release identity is unavailable.",
    );
  }
  const installer = signedInstallerPath();
  await mkdir(input.stateDirectory, { recursive: true, mode: 0o700 });
  const state = await lstat(input.stateDirectory);
  if (
    !state.isDirectory() ||
    (state.mode & 0o077) !== 0 ||
    state.uid !== process.getuid?.()
  ) {
    throw new SignedInstallError(
      "Installation state must be a private directory owned by the current user.",
    );
  }
  const directory = await mkdtemp(join(input.stateDirectory, "install-"));
  const journal = join(directory, "journal.jsonl");
  const log = join(directory, "executor.log");
  const fd = openSync(log, "wx", 0o600);
  try {
    const args = [
      installer,
      "--manifest",
      input.manifestPath,
      "--expected-subject-sha256",
      input.subjectSha256,
      "--artifact-dir",
      input.artifactDir,
      "--device",
      input.serial,
      "--tool-dir",
      input.toolDir,
      "--recovery-dir",
      input.artifactDir,
      "--journal",
      journal,
      "--health-token-file",
      input.healthTokenFile,
      "--execute",
      "--confirm-flash",
      "--reboot-after-flash",
    ];
    if (input.wipe) args.push("--wipe-data");
    // Do not kill the executor with an outer timer while it settles disk effects.
    // Its checked transports enforce the authenticated per-command deadlines.
    const child = spawn("node", args, { stdio: ["ignore", fd, fd] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new SignedInstallError(`Signed executor exited ${code ?? signal}`),
          );
      });
    });
    const bytes = await readFile(journal, "utf8");
    if (!bytes.endsWith("\n"))
      throw new SignedInstallError("Installation journal is incomplete.");
    const events = bytes
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const first = events[0];
    const last = events.at(-1);
    if (
      first?.event !== "authorized" ||
      first.serial !== input.serial ||
      first.subjectSha256 !== input.subjectSha256 ||
      events.some((event) => event.event === "failed") ||
      last?.event !== "installed-runtime-verified" ||
      last.subjectSha256 !== input.subjectSha256
    ) {
      throw new SignedInstallError(
        "Installation lacks matching authenticated runtime verification.",
      );
    }
    return journal;
  } catch (error) {
    const output = await readFile(log, "utf8");
    throw new SignedInstallError(
      `${error instanceof Error ? error.message : String(error)}${output ? `\n${output}` : ""}\nInstallation evidence: ${directory}`,
      { cause: error },
    );
  } finally {
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
