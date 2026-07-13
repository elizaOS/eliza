/**
 * Crash-safe first-use provisioning for the workspace-native eliza-code ACP
 * server. An OS advisory lock serializes builders and is released by the kernel
 * when its owning process exits, so recovery never depends on PID liveness,
 * wall-clock age, or deleting another process's lock. Builds target private
 * artifacts and publish only after validation (#16169).
 *
 * Linux hosts use util-linux `flock` to acquire the advisory lock on an
 * inherited file descriptor and GNU `timeout` to terminate the complete build
 * process group at the shared deadline. Hosts without those proven primitives
 * decline the workspace build and let the service fall back to its configured/
 * published ACP command rather than weakening exclusion or supervision.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { ElizaError, logger } from "@elizaos/core";

const BUILD_TIMEOUT_MS = 120_000;
const PROVISION_DEADLINE_MS = 180_000;
const WAIT_POLL_MS = 100;
const ACP_ARTIFACT_MARKER = "eliza-code-acp";
const BUILD_RECIPE_VERSION = "acp-private-bun-build-v1";
const RUNTIME_TSCONFIG_CONTENT = `${JSON.stringify(
  { compilerOptions: {} },
  null,
  2,
)}\n`;

export type AcpProvisionResult = {
  command: string;
  args: string[];
};

type BuildResult = {
  ok: boolean;
  detail: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  inputFiles?: string[];
  cause?: unknown;
};

type BuildContext = {
  bun: string;
  packageDir: string;
  source: string;
  tmpOutput: string;
  tmpMetafile: string;
  timeoutMs: number;
};

type BuildLease = {
  release: () => void;
};

export type ProvisionHooks = {
  build?: (context: BuildContext) => BuildResult;
  now?: () => number;
  deadlineMs?: number;
  tryAcquireBuildLease?: (
    guardPath: string,
    timeoutMs: number,
  ) => BuildLease | undefined;
};

type ProvisionPaths = {
  packageDir: string;
  distDir: string;
  source: string;
  output: string;
  runtimeTsconfig: string;
  completionMarker: string;
  guard: string;
  ownerMetadata: string;
};

type OwnerMetadata = {
  pid: number;
  fence: string;
  startedAtMs: number;
};

type OwnerMetadataRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; value: OwnerMetadata };

type CompletionMarker = {
  version: 2;
  size: number;
  mtimeMs: number;
  outputHash: string;
  inputHash: string;
  inputFiles: string[];
};

function quoteAcpToken(value: string): string {
  if (value.length > 0 && !/[\s"']/u.test(value)) return value;
  if (value.includes('"') && !value.includes("'")) return `'${value}'`;
  if (value.includes('"') && value.includes("'")) {
    throw new ElizaError(
      "Cannot format ACP command path containing both single and double quotes",
      {
        code: "ACP_COMMAND_PATH_UNREPRESENTABLE",
        context: { tokenLength: value.length },
        severity: "fatal",
      },
    );
  }
  return `"${value}"`;
}

export function formatAcpCommand(result: AcpProvisionResult): string {
  return [result.command, ...result.args].map(quoteAcpToken).join(" ");
}

function findExecutableOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findUtilLinuxFlockOnPath(timeoutMs: number): string | undefined {
  const flock = findExecutableOnPath("flock");
  if (!flock || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const probe = spawnSync(flock, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: Math.max(1, Math.floor(Math.min(1_000, timeoutMs))),
    killSignal: "SIGKILL",
  });
  return probe.status === 0 &&
    String(probe.stdout ?? "").includes("flock from util-linux")
    ? flock
    : undefined;
}

export function findWorkspaceElizaCodePackage(
  startDir: string,
): string | undefined {
  let directory = resolve(startDir);
  while (true) {
    const candidate = join(directory, "packages", "examples", "code");
    if (existsSync(join(candidate, "src", "acp.ts"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function provisionPaths(packageDir: string): ProvisionPaths {
  const distDir = join(packageDir, "dist");
  return {
    packageDir,
    distDir,
    source: join(packageDir, "src", "acp.ts"),
    output: join(distDir, "acp.js"),
    runtimeTsconfig: join(distDir, "tsconfig.json"),
    completionMarker: join(distDir, ".acp.done"),
    guard: join(distDir, ".acp.build.guard"),
    ownerMetadata: join(distDir, ".acp.build.owner"),
  };
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function filesystemError(
  message: string,
  code: string,
  path: string,
  cause: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    cause,
    context: { path },
    severity: "fatal",
  });
}

function bestEffortRemove(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch (error) {
    // error-policy:J6 scratch cleanup cannot change the already-determined
    // provisioning outcome, but it remains observable for operators.
    logger.warn(
      { error, path },
      "[AcpProvisioning] Could not remove provisioning scratch path",
    );
  }
}

function removeOrThrow(path: string, operation: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch (cause) {
    // error-policy:J2 preserve the filesystem cause while adding operation and
    // path context at this provisioning boundary.
    throw filesystemError(
      `Failed to ${operation}`,
      "ACP_PROVISIONING_FILESYSTEM_FAILED",
      path,
      cause,
    );
  }
}

function createFlockLeaseFactory(
  flock: string,
): (guardPath: string, timeoutMs: number) => BuildLease | undefined {
  return (guardPath, timeoutMs) => {
    let descriptor: number;
    try {
      descriptor = openSync(guardPath, "a+");
    } catch (cause) {
      // error-policy:J2 advisory-lock setup failures carry their OS cause and
      // the exact guard path needed for diagnosis.
      throw filesystemError(
        "Failed to open ACP provisioning advisory lock",
        "ACP_PROVISIONING_LOCK_OPEN_FAILED",
        guardPath,
        cause,
      );
    }

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(flock, ["-x", "-n", "3"], {
        stdio: ["ignore", "pipe", "pipe", descriptor],
        encoding: "utf8",
        timeout: Math.max(1, Math.floor(Math.min(5_000, timeoutMs))),
        killSignal: "SIGKILL",
      });
    } catch (cause) {
      // error-policy:J2 acquisition setup failures retain their cause after the
      // opened descriptor is closed, so a bad invocation cannot leak a lease.
      try {
        closeSync(descriptor);
      } catch (releaseError) {
        // error-policy:J6 the acquisition failure owns the outcome; descriptor
        // cleanup failure is logged without replacing that primary error.
        logger.error(
          { error: releaseError, guardPath },
          "[AcpProvisioning] Could not close advisory-lock descriptor after acquisition failed",
        );
      }
      throw new ElizaError("Failed to invoke ACP provisioning advisory lock", {
        code: "ACP_PROVISIONING_LOCK_FAILED",
        cause,
        context: { guardPath, timeoutMs },
        severity: "fatal",
      });
    }
    if (result.status === 0) {
      return {
        release: () => {
          try {
            closeSync(descriptor);
          } catch (cause) {
            // error-policy:J2 a failed lease release is surfaced with its OS
            // cause because silently retaining exclusion could deadlock work.
            throw filesystemError(
              "Failed to release ACP provisioning advisory lock",
              "ACP_PROVISIONING_LOCK_RELEASE_FAILED",
              guardPath,
              cause,
            );
          }
        },
      };
    }

    try {
      closeSync(descriptor);
    } catch (cause) {
      // error-policy:J2 closing an unclaimed descriptor is part of the lock
      // boundary and preserves the underlying OS failure.
      throw filesystemError(
        "Failed to close unclaimed ACP provisioning lock descriptor",
        "ACP_PROVISIONING_LOCK_RELEASE_FAILED",
        guardPath,
        cause,
      );
    }
    if (result.status === 1 && result.error === undefined) return undefined;

    const stdout = String(result.stdout ?? "")
      .trim()
      .slice(-4000);
    const stderr = String(result.stderr ?? "")
      .trim()
      .slice(-4000);
    const timedOut = errnoCode(result.error) === "ETIMEDOUT";
    throw new ElizaError(
      timedOut
        ? "Timed out acquiring the ACP provisioning advisory lock"
        : "Failed to acquire ACP provisioning advisory lock",
      {
        code: timedOut
          ? "ACP_PROVISIONING_LOCK_TIMEOUT"
          : "ACP_PROVISIONING_LOCK_FAILED",
        cause: result.error,
        context: {
          guardPath,
          status: result.status,
          signal: result.signal,
          timedOut,
          stdout,
          stderr,
        },
        severity: timedOut ? "ephemeral" : "fatal",
      },
    );
  };
}

function writeOwnerMetadata(
  paths: ProvisionPaths,
  metadata: OwnerMetadata,
): void {
  const temporary = `${paths.ownerMetadata}.${metadata.fence}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(metadata));
    renameSync(temporary, paths.ownerMetadata);
  } catch (cause) {
    // error-policy:J2 metadata publication preserves the filesystem cause and
    // cleans only this owner's private temporary file.
    bestEffortRemove(temporary);
    throw filesystemError(
      "Failed to publish ACP provisioning owner metadata",
      "ACP_PROVISIONING_OWNER_METADATA_FAILED",
      paths.ownerMetadata,
      cause,
    );
  }
}

function readOwnerMetadata(path: string): OwnerMetadataRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    // error-policy:J3 absence is an explicit diagnostic state; every other I/O
    // failure is rethrown with its cause instead of fabricating metadata.
    if (errnoCode(cause) === "ENOENT") return { kind: "absent" };
    throw filesystemError(
      "Failed to read ACP provisioning owner metadata",
      "ACP_PROVISIONING_OWNER_METADATA_FAILED",
      path,
      cause,
    );
  }

  try {
    const parsed = JSON.parse(raw) as Partial<OwnerMetadata>;
    if (
      Number.isInteger(parsed.pid) &&
      typeof parsed.fence === "string" &&
      parsed.fence.length > 0 &&
      typeof parsed.startedAtMs === "number" &&
      Number.isFinite(parsed.startedAtMs)
    ) {
      return { kind: "valid", value: parsed as OwnerMetadata };
    }
  } catch {
    // error-policy:J3 owner metadata is diagnostic-only untrusted input; an
    // invalid record remains visibly invalid and never authorizes cleanup.
    return { kind: "invalid" };
  }
  return { kind: "invalid" };
}

function removeOwnedMetadata(paths: ProvisionPaths, fence: string): void {
  const current = readOwnerMetadata(paths.ownerMetadata);
  if (current.kind === "valid" && current.value.fence === fence) {
    removeOrThrow(
      paths.ownerMetadata,
      "remove ACP provisioning owner metadata",
    );
  }
}

function collectPackageSourceInputs(packageDir: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (cause) {
      // error-policy:J2 input enumeration must fail with directory context
      // because an incomplete list could incorrectly bless a stale bundle.
      throw filesystemError(
        "Failed to enumerate ACP build inputs",
        "ACP_PROVISIONING_INPUT_READ_FAILED",
        directory,
        cause,
      );
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };

  visit(join(packageDir, "src"));
  for (const configuration of ["package.json", "tsconfig.json"]) {
    const path = join(packageDir, configuration);
    if (existsSync(path)) files.push(path);
  }
  return files.sort();
}

function workspaceRootForPackage(packageDir: string): string {
  return resolve(packageDir, "../../..");
}

function isWithinWorkspace(path: string, workspaceRoot: string): boolean {
  return path === workspaceRoot || path.startsWith(`${workspaceRoot}${sep}`);
}

function normalizeRecordedInputs(
  packageDir: string,
  inputFiles: string[],
): string[] | undefined {
  if (inputFiles.length > 10_000) return undefined;
  const workspaceRoot = workspaceRootForPackage(packageDir);
  const normalized = new Set<string>();
  for (const input of inputFiles) {
    if (typeof input !== "string" || input.length === 0 || input.includes("\0"))
      return undefined;
    const absolute = resolve(packageDir, input);
    if (!isWithinWorkspace(absolute, workspaceRoot)) return undefined;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
    } catch (cause) {
      // error-policy:J3 missing prior inputs remain an explicit freshness
      // change; unreadable or unsupported marker paths invalidate the marker.
      if (errnoCode(cause) !== "ENOENT") return undefined;
    }
    normalized.add(relative(packageDir, absolute));
  }
  return [...normalized].sort();
}

function collectResolverInputs(
  packageDir: string,
  recordedInputs: string[],
): string[] {
  const workspaceRoot = workspaceRootForPackage(packageDir);
  const files = new Set(collectPackageSourceInputs(packageDir));
  let rootEntries: string[];
  try {
    rootEntries = readdirSync(workspaceRoot);
  } catch (cause) {
    // error-policy:J2 resolver-input enumeration preserves the filesystem
    // cause rather than hashing an incomplete workspace configuration.
    throw filesystemError(
      "Failed to enumerate ACP workspace resolver inputs",
      "ACP_PROVISIONING_INPUT_READ_FAILED",
      workspaceRoot,
      cause,
    );
  }
  for (const name of rootEntries) {
    if (
      name === "package.json" ||
      name === "bun.lock" ||
      name === "bun.lockb" ||
      name === "bunfig.toml" ||
      /^tsconfig(?:\..+)?\.json$/u.test(name)
    ) {
      const path = join(workspaceRoot, name);
      if (existsSync(path)) files.add(path);
    }
  }

  for (const recorded of recordedInputs) {
    const absolute = resolve(packageDir, recorded);
    files.add(absolute);
    let directory = dirname(absolute);
    while (isWithinWorkspace(directory, workspaceRoot)) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) {
        files.add(manifest);
        break;
      }
      if (directory === workspaceRoot) break;
      directory = dirname(directory);
    }
  }
  return [...files].sort();
}

function computeBuildInputHash(
  packageDir: string,
  bun: string,
  recordedInputs: string[],
): string {
  const hash = createHash("sha256");
  hash.update(BUILD_RECIPE_VERSION);
  let resolvedBun: string;
  let bunStat: ReturnType<typeof statSync>;
  try {
    resolvedBun = realpathSync(bun);
    bunStat = statSync(resolvedBun);
  } catch (cause) {
    // error-policy:J2 toolchain identification adds the executable path while
    // preserving the OS failure as the structured cause.
    throw filesystemError(
      "Failed to identify the Bun executable used for ACP provisioning",
      "ACP_PROVISIONING_INPUT_READ_FAILED",
      bun,
      cause,
    );
  }
  hash.update(
    `\0bun\0${resolvedBun}\0${bunStat.size}\0${bunStat.mtimeMs}\0${bunStat.ino}\0`,
  );
  for (const path of collectResolverInputs(packageDir, recordedInputs)) {
    const relativePath = relative(workspaceRootForPackage(packageDir), path);
    hash.update(`\0${relativePath}\0`);
    try {
      const stat = lstatSync(path);
      if (stat.isFile()) {
        const content = readFileSync(path);
        hash.update(`type=file\0${content.length}\0`);
        hash.update(content);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const content = readFileSync(path);
        hash.update(
          `type=symlink\0${Buffer.byteLength(target)}\0${target}\0${content.length}\0`,
        );
        hash.update(content);
      } else {
        throw new ElizaError("ACP build input is not a file or symbolic link", {
          code: "ACP_PROVISIONING_INPUT_INVALID",
          context: { path },
          severity: "fatal",
        });
      }
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") {
        // error-policy:J3 a recorded input that no longer exists is an explicit
        // freshness change, not a fabricated empty file or fatal cache state.
        hash.update("type=missing\0");
        continue;
      }
      // error-policy:J2 hashing must surface the exact unreadable input and OS
      // cause; omitting it would make the freshness proof unsound.
      throw filesystemError(
        "Failed to hash ACP build input",
        "ACP_PROVISIONING_INPUT_READ_FAILED",
        path,
        cause,
      );
    }
  }
  return hash.digest("hex");
}

function readCompletionMarker(path: string): CompletionMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    // error-policy:J3 a missing marker is the explicit not-built state; other
    // read failures remain fatal and retain their filesystem cause.
    if (errnoCode(cause) === "ENOENT") return undefined;
    throw filesystemError(
      "Failed to read ACP completion marker",
      "ACP_PROVISIONING_MARKER_READ_FAILED",
      path,
      cause,
    );
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CompletionMarker>;
    if (
      parsed.version === 2 &&
      typeof parsed.size === "number" &&
      typeof parsed.mtimeMs === "number" &&
      typeof parsed.outputHash === "string" &&
      typeof parsed.inputHash === "string" &&
      Array.isArray(parsed.inputFiles) &&
      parsed.inputFiles.every((input) => typeof input === "string")
    ) {
      return parsed as CompletionMarker;
    }
  } catch {
    // error-policy:J3 an interrupted or tampered marker is explicitly invalid,
    // so callers rebuild instead of treating it as a valid completion record.
    return undefined;
  }
  return undefined;
}

function recordedBuildInputs(paths: ProvisionPaths): string[] {
  const marker = readCompletionMarker(paths.completionMarker);
  if (!marker) return [];
  const normalized = normalizeRecordedInputs(
    paths.packageDir,
    marker.inputFiles,
  );
  // An invalid old marker never authorizes reuse. The conservative source,
  // resolver, lockfile, and toolchain snapshot still protects the rebuild.
  if (!normalized) return [];
  return normalized;
}

function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (cause) {
    // error-policy:J2 artifact hashing retains the underlying read failure and
    // identifies the file whose integrity could not be established.
    throw filesystemError(
      "Failed to hash ACP build artifact",
      "ACP_PROVISIONING_ARTIFACT_READ_FAILED",
      path,
      cause,
    );
  }
}

function isFreshArtifact(paths: ProvisionPaths, bun: string): boolean {
  const marker = readCompletionMarker(paths.completionMarker);
  if (!marker) return false;
  const inputFiles = normalizeRecordedInputs(
    paths.packageDir,
    marker.inputFiles,
  );
  if (!inputFiles) return false;
  const inputHash = computeBuildInputHash(paths.packageDir, bun, inputFiles);

  let outputStat: ReturnType<typeof statSync>;
  let runtimeTsconfig: string;
  try {
    outputStat = statSync(paths.output);
    runtimeTsconfig = readFileSync(paths.runtimeTsconfig, "utf8");
  } catch (cause) {
    // error-policy:J3 missing cache components explicitly invalidate the
    // artifact; other read failures surface with their cause.
    if (errnoCode(cause) === "ENOENT") return false;
    throw filesystemError(
      "Failed to inspect ACP executable freshness",
      "ACP_PROVISIONING_ARTIFACT_READ_FAILED",
      paths.output,
      cause,
    );
  }

  return (
    marker.inputHash === inputHash &&
    marker.size === outputStat.size &&
    marker.mtimeMs === outputStat.mtimeMs &&
    marker.outputHash === hashFile(paths.output) &&
    runtimeTsconfig === RUNTIME_TSCONFIG_CONTENT
  );
}

function findGnuTimeoutOnPath(timeoutMs: number): string | undefined {
  const timeout = findExecutableOnPath("timeout");
  if (!timeout || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return undefined;
  const probe = spawnSync(timeout, ["--version"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: Math.max(1, Math.floor(Math.min(1_000, timeoutMs))),
    killSignal: "SIGKILL",
  });
  return probe.status === 0 &&
    String(probe.stdout ?? "").includes("GNU coreutils")
    ? timeout
    : undefined;
}

function defaultBuild(context: BuildContext, supervisor: string): BuildResult {
  const buildArgs = [
    "build",
    "--conditions=eliza-source",
    context.source,
    `--outfile=${context.tmpOutput}`,
    `--metafile=${context.tmpMetafile}`,
    "--target=bun",
    "--external=@elizaos/core",
    "--external=@elizaos/plugin-*",
  ];
  const timeoutMs = Math.max(
    1,
    Math.floor(Math.min(BUILD_TIMEOUT_MS, context.timeoutMs)),
  );
  if (timeoutMs <= 75) {
    return {
      ok: false,
      detail: "shared deadline has no process-group termination budget",
      timedOut: true,
    };
  }
  const supervisedTimeoutMs = Math.max(1, timeoutMs - 75);
  const result = spawnSync(
    supervisor,
    [
      "--signal=TERM",
      "--kill-after=0.05s",
      `${supervisedTimeoutMs / 1000}s`,
      context.bun,
      ...buildArgs,
    ],
    {
      cwd: context.packageDir,
      env: process.env,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const stdout = String(result.stdout ?? "").slice(-4000);
  const stderr = String(result.stderr ?? "").slice(-4000);
  const timedOut =
    errnoCode(result.error) === "ETIMEDOUT" ||
    result.status === 124 ||
    result.status === 137 ||
    (result.status === null && result.signal === "SIGKILL");
  const ok =
    result.status === 0 &&
    existsSync(context.tmpOutput) &&
    existsSync(context.tmpMetafile);
  let inputFiles: string[] | undefined;
  if (ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(context.tmpMetafile, "utf8"));
    } catch (cause) {
      // error-policy:J2 Bun's malformed build record is rethrown with the parse
      // or read cause and private metafile path.
      throw new ElizaError("Bun produced an unreadable ACP build metafile", {
        code: "ACP_PROVISIONING_METAFILE_INVALID",
        cause,
        context: { path: context.tmpMetafile },
        severity: "fatal",
      });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("inputs" in parsed) ||
      typeof parsed.inputs !== "object" ||
      parsed.inputs === null ||
      Array.isArray(parsed.inputs)
    ) {
      throw new ElizaError("Bun produced an invalid ACP build metafile", {
        code: "ACP_PROVISIONING_METAFILE_INVALID",
        context: { path: context.tmpMetafile },
        severity: "fatal",
      });
    }
    inputFiles = normalizeRecordedInputs(
      context.packageDir,
      Object.keys(parsed.inputs),
    );
    if (!inputFiles || inputFiles.length === 0) {
      throw new ElizaError("Bun produced unsafe ACP build input paths", {
        code: "ACP_PROVISIONING_METAFILE_INVALID",
        context: { path: context.tmpMetafile },
        severity: "fatal",
      });
    }
  }
  return {
    ok,
    detail: ok
      ? ""
      : `status=${String(result.status)}; signal=${String(result.signal)}; timedOut=${String(timedOut)}`,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    timedOut,
    inputFiles,
    cause: result.error,
  };
}

function validateArtifact(path: string): boolean {
  try {
    const stat = statSync(path);
    return (
      stat.size > 0 && readFileSync(path, "utf8").includes(ACP_ARTIFACT_MARKER)
    );
  } catch (cause) {
    // error-policy:J3 a missing private artifact is explicitly invalid; other
    // validation failures retain their filesystem cause.
    if (errnoCode(cause) === "ENOENT") return false;
    throw filesystemError(
      "Failed to validate ACP build artifact",
      "ACP_PROVISIONING_ARTIFACT_READ_FAILED",
      path,
      cause,
    );
  }
}

function publishBuild(
  paths: ProvisionPaths,
  bun: string,
  fence: string,
  timeoutMs: number,
  build: (context: BuildContext) => BuildResult,
  baselineHash: string,
  baselineInputs: string[],
): void {
  const tmpOutput = join(paths.distDir, `.acp.${fence}.tmp.js`);
  const tmpMetafile = join(paths.distDir, `.acp.${fence}.metafile.tmp.json`);
  const tmpRuntimeConfig = join(
    paths.distDir,
    `.acp.${fence}.runtime-config.tmp.json`,
  );
  const tmpMarker = join(paths.distDir, `.acp.${fence}.marker.tmp.json`);
  removeOrThrow(tmpOutput, "remove an old ACP private build artifact");
  removeOrThrow(tmpMetafile, "remove an old ACP private build metafile");

  let result: BuildResult;
  try {
    result = build({
      bun,
      packageDir: paths.packageDir,
      source: paths.source,
      tmpOutput,
      tmpMetafile,
      timeoutMs,
    });
  } catch (cause) {
    // error-policy:J2 the build boundary adds package/deadline context and
    // retains the original thrown failure as its cause.
    bestEffortRemove(tmpOutput);
    bestEffortRemove(tmpMetafile);
    throw new ElizaError("ACP workspace build threw before publishing", {
      code: "ACP_PROVISIONING_BUILD_FAILED",
      cause,
      context: { packageDir: paths.packageDir, timeoutMs },
      severity: "ephemeral",
    });
  }

  if (!result.ok || !validateArtifact(tmpOutput)) {
    bestEffortRemove(tmpOutput);
    bestEffortRemove(tmpMetafile);
    throw new ElizaError(
      result.ok
        ? "Failed to auto-install eliza-code-acp: built artifact failed validation"
        : `Failed to auto-install eliza-code-acp: ${result.detail.slice(0, 4000)}`,
      {
        code: result.ok
          ? "ACP_PROVISIONING_ARTIFACT_INVALID"
          : "ACP_PROVISIONING_BUILD_FAILED",
        cause: result.cause,
        context: {
          packageDir: paths.packageDir,
          timeoutMs,
          status: result.status,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout?.slice(-4000),
          stderr: result.stderr?.slice(-4000),
        },
        severity: result.ok ? "fatal" : "ephemeral",
      },
    );
  }

  const completedBaselineHash = computeBuildInputHash(
    paths.packageDir,
    bun,
    baselineInputs,
  );
  if (completedBaselineHash !== baselineHash) {
    bestEffortRemove(tmpOutput);
    bestEffortRemove(tmpMetafile);
    throw new ElizaError(
      "ACP build inputs changed while the bundle was built",
      {
        code: "ACP_PROVISIONING_INPUTS_CHANGED",
        context: { packageDir: paths.packageDir },
        severity: "ephemeral",
      },
    );
  }

  const inputFiles = result.inputFiles ?? [];
  const inputHash = computeBuildInputHash(paths.packageDir, bun, inputFiles);

  try {
    removeOrThrow(
      paths.completionMarker,
      "invalidate the previous ACP completion marker",
    );
    writeFileSync(tmpRuntimeConfig, RUNTIME_TSCONFIG_CONTENT);
    renameSync(tmpRuntimeConfig, paths.runtimeTsconfig);
    renameSync(tmpOutput, paths.output);
    const published = statSync(paths.output);
    const marker: CompletionMarker = {
      version: 2,
      size: published.size,
      mtimeMs: published.mtimeMs,
      outputHash: hashFile(paths.output),
      inputHash,
      inputFiles,
    };
    writeFileSync(tmpMarker, JSON.stringify(marker));
    renameSync(tmpMarker, paths.completionMarker);
  } catch (cause) {
    // error-policy:J2 atomic publication failures retain their cause and clean
    // only fence-private artifacts before surfacing.
    bestEffortRemove(tmpOutput);
    bestEffortRemove(tmpMetafile);
    bestEffortRemove(tmpRuntimeConfig);
    bestEffortRemove(tmpMarker);
    throw new ElizaError("Failed to atomically publish eliza-code-acp", {
      code: "ACP_PROVISIONING_PUBLISH_FAILED",
      cause,
      context: { packageDir: paths.packageDir },
      severity: "fatal",
    });
  }
  bestEffortRemove(tmpMetafile);
}

function cleanupPrivateArtifacts(paths: ProvisionPaths): void {
  let names: string[];
  try {
    names = readdirSync(paths.distDir);
  } catch (cause) {
    // error-policy:J6 an absent scratch directory needs no teardown; every
    // other cleanup-enumeration failure remains observable.
    if (errnoCode(cause) === "ENOENT") return;
    throw filesystemError(
      "Failed to enumerate ACP provisioning scratch artifacts",
      "ACP_PROVISIONING_FILESYSTEM_FAILED",
      paths.distDir,
      cause,
    );
  }
  for (const name of names) {
    if (/^\.acp\..+\.tmp\.(?:js|json)$/u.test(name)) {
      bestEffortRemove(join(paths.distDir, name));
    }
  }
}

function ownerContext(metadata: OwnerMetadataRead): Record<string, unknown> {
  if (metadata.kind === "valid") {
    return {
      ownerPid: metadata.value.pid,
      ownerFence: metadata.value.fence,
      ownerStartedAtMs: metadata.value.startedAtMs,
    };
  }
  return { ownerMetadata: metadata.kind };
}

export function provisionWorkspaceElizaCodeAcp(
  startDir: string = process.cwd(),
  hooks: ProvisionHooks = {},
): AcpProvisionResult | undefined {
  const packageDir = findWorkspaceElizaCodePackage(startDir);
  const bun = findExecutableOnPath("bun");
  if (!packageDir || !bun) return undefined;

  const paths = provisionPaths(packageDir);
  const now = hooks.now ?? performance.now.bind(performance);
  const deadlineMs = hooks.deadlineMs ?? PROVISION_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new ElizaError(
      "ACP provisioning deadline must be finite and positive",
      {
        code: "ACP_PROVISIONING_DEADLINE_INVALID",
        context: { packageDir, deadlineMs },
        severity: "fatal",
      },
    );
  }
  const deadline = now() + deadlineMs;
  const leaseFactory =
    hooks.tryAcquireBuildLease ??
    (() => {
      const flock = findUtilLinuxFlockOnPath(deadline - now());
      return flock ? createFlockLeaseFactory(flock) : undefined;
    })();
  if (!leaseFactory) return undefined;

  let build: (context: BuildContext) => BuildResult;
  if (hooks.build) {
    build = hooks.build;
  } else {
    const supervisor = findGnuTimeoutOnPath(deadline - now());
    if (!supervisor) return undefined;
    build = (context) => defaultBuild(context, supervisor);
  }
  try {
    mkdirSync(paths.distDir, { recursive: true });
  } catch (cause) {
    // error-policy:J2 provisioning-directory creation preserves the OS cause
    // and destination path for the caller.
    throw filesystemError(
      "Failed to create ACP provisioning directory",
      "ACP_PROVISIONING_FILESYSTEM_FAILED",
      paths.distDir,
      cause,
    );
  }

  while (true) {
    if (isFreshArtifact(paths, bun)) {
      return { command: bun, args: [paths.output] };
    }

    const acquireBudgetMs = deadline - now();
    if (acquireBudgetMs <= 0) {
      const metadata = readOwnerMetadata(paths.ownerMetadata);
      throw new ElizaError(
        "Timed out waiting for the live ACP workspace build owner",
        {
          code: "ACP_PROVISIONING_LOCK_TIMEOUT",
          context: { packageDir, deadlineMs, ...ownerContext(metadata) },
          severity: "ephemeral",
        },
      );
    }
    const lease = leaseFactory(paths.guard, acquireBudgetMs);
    if (lease) {
      const fence = randomBytes(16).toString("hex");
      let operationFailed = false;
      let operationError: unknown;
      let provisioned: AcpProvisionResult | undefined;
      try {
        cleanupPrivateArtifacts(paths);
        writeOwnerMetadata(paths, {
          pid: process.pid,
          fence,
          startedAtMs: now(),
        });
        const baselineInputs = recordedBuildInputs(paths);
        const lockedInputHash = computeBuildInputHash(
          packageDir,
          bun,
          baselineInputs,
        );
        if (isFreshArtifact(paths, bun)) {
          provisioned = { command: bun, args: [paths.output] };
        } else {
          const remainingMs = deadline - now();
          if (remainingMs <= 0) {
            throw new ElizaError(
              "ACP provisioning deadline elapsed before the build started",
              {
                code: "ACP_PROVISIONING_DEADLINE_EXCEEDED",
                context: { packageDir, deadlineMs },
                severity: "ephemeral",
              },
            );
          }
          publishBuild(
            paths,
            bun,
            fence,
            remainingMs,
            build,
            lockedInputHash,
            baselineInputs,
          );
          cleanupPrivateArtifacts(paths);
          provisioned = { command: bun, args: [paths.output] };
        }
      } catch (error) {
        // error-policy:J6 defer the primary failure only long enough to release
        // the lease and owner metadata, then rethrow it unchanged.
        operationFailed = true;
        operationError = error;
      }

      let releaseError: unknown;
      try {
        removeOwnedMetadata(paths, fence);
      } catch (error) {
        // error-policy:J6 lease release must still run when diagnostic metadata
        // teardown fails; this error is surfaced after the descriptor closes.
        releaseError = error;
      }
      try {
        lease.release();
      } catch (error) {
        // error-policy:J6 descriptor teardown failures are surfaced unless a
        // primary failure already owns the outcome, in which case they log.
        if (releaseError === undefined) releaseError = error;
        else {
          // error-policy:J6 both release failures are reported while the first
          // remains the structured failure surfaced to the caller.
          logger.error(
            { error, packageDir },
            "[AcpProvisioning] Advisory lock release also failed after metadata cleanup failed",
          );
        }
      }
      if (operationFailed) {
        if (releaseError !== undefined) {
          // error-policy:J6 release diagnostics must not replace the original
          // build/publish failure, but they remain observable.
          logger.error(
            { error: releaseError, packageDir },
            "[AcpProvisioning] Failed to release advisory lock after an earlier provisioning failure",
          );
        }
        throw operationError;
      }
      if (releaseError !== undefined) throw releaseError;
      if (provisioned) return provisioned;
      throw new ElizaError("ACP provisioning produced no result", {
        code: "ACP_PROVISIONING_INVARIANT_FAILED",
        context: { packageDir },
        severity: "fatal",
      });
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      const metadata = readOwnerMetadata(paths.ownerMetadata);
      throw new ElizaError(
        "Timed out waiting for the live ACP workspace build owner",
        {
          code: "ACP_PROVISIONING_LOCK_TIMEOUT",
          context: { packageDir, deadlineMs, ...ownerContext(metadata) },
          severity: "ephemeral",
        },
      );
    }
    sleepSync(Math.min(WAIT_POLL_MS, remainingMs));
  }
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(0, ms));
}
