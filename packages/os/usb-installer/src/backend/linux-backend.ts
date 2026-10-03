import type { ChildProcess, SpawnOptions } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  LsblkParseError,
  NoPrivilegeEscalatorError,
  UnmountFailedError,
  WriteCancelledError,
  WriteIncompleteError,
} from "./errors";
import { downloadFile } from "./image-download";
import { sha256File } from "./image-file";
import { withTemporaryImageDirectory } from "./image-workspace";
import {
  type RawImageTarget,
  writeVerifiedRawImage,
} from "./raw-image-pipeline";
import { fetchReleaseImages } from "./release-manifest";
import type {
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WriteExecutionOptions,
  WritePlan,
  WriteRequest,
} from "./types";
import {
  assertDriveMatchesExpected,
  assertWritePlanAllowed,
} from "./write-safety";

const execFileAsync = promisify(execFile);

const STEP_LABELS: Record<InstallerStepId, string> = {
  "resolve-image": "Resolve image",
  checksum: "Validate checksum",
  write: "Write image",
  verify: "Finalize media",
  complete: "Complete",
};

const DEFAULT_RAW_WRITER = path.resolve(
  import.meta.dirname,
  "../../native/build/linux-raw-writer",
);
const SYSTEM_MOUNTPOINTS = new Set([
  "/",
  "/boot",
  "/boot/efi",
  "/run/live/medium",
  "/run/live/persistence",
  "/live/medium",
]);

interface LsblkDevice {
  name: string;
  size: string | number;
  type: string;
  rm: boolean | string;
  model: string | null;
  serial?: string | null;
  "maj:min"?: string;
  "disk-seq"?: number;
  "log-sec"?: number;
  wwn?: string | null;
  tran: string | null;
  hotplug: boolean | string;
  mountpoint?: string | null;
  mountpoints?: (string | null)[] | string | null;
  children?: LsblkDevice[];
}

interface LsblkOutput {
  blockdevices: LsblkDevice[];
}

function isRemovable(device: LsblkDevice): boolean {
  return (
    device.rm === true ||
    device.rm === "1" ||
    device.hotplug === true ||
    device.hotplug === "1" ||
    device.tran === "usb"
  );
}

function mountpointsForDevice(device: LsblkDevice): string[] {
  const values: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (normalized) values.push(normalized);
  };

  add(device.mountpoint);
  if (Array.isArray(device.mountpoints)) {
    for (const mountpoint of device.mountpoints) add(mountpoint);
  } else if (typeof device.mountpoints === "string") {
    add(device.mountpoints);
  }

  for (const child of device.children ?? []) {
    values.push(...mountpointsForDevice(child));
  }

  return values;
}

function currentSystemMountpoint(device: LsblkDevice): string | null {
  for (const mountpoint of mountpointsForDevice(device)) {
    if (SYSTEM_MOUNTPOINTS.has(mountpoint)) {
      return mountpoint;
    }
  }

  return null;
}

function decodeMountInfoField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function blockNameFromDevPath(devicePath: string): string | null {
  if (!devicePath.startsWith("/dev/")) {
    return null;
  }
  return path.basename(devicePath);
}

function fallbackParentDiskName(blockName: string): string | null {
  const partitionPatterns = [/^(?<disk>.+\d+)p\d+$/, /^(?<disk>[a-z]+)\d+$/i];

  for (const pattern of partitionPatterns) {
    const match = blockName.match(pattern);
    const disk = match?.groups?.disk;
    if (disk && disk !== blockName) {
      return disk;
    }
  }

  return null;
}

async function sysfsBlockAncestors(
  blockName: string,
  visited = new Set<string>(),
): Promise<Set<string>> {
  const names = new Set<string>();
  if (visited.has(blockName)) {
    return names;
  }
  visited.add(blockName);
  names.add(blockName);

  const sysfsPath = path.join("/sys/class/block", blockName);
  try {
    const slaves = await fs.readdir(path.join(sysfsPath, "slaves"));
    for (const slave of slaves) {
      for (const name of await sysfsBlockAncestors(slave, visited)) {
        names.add(name);
      }
    }
  } catch (error) {
    // Partitions may omit this directory; other failures leave ancestry unknown.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    const realPath = await fs.realpath(sysfsPath);
    const parentName = path.basename(path.dirname(realPath));
    if (parentName && parentName !== blockName && parentName !== "block") {
      await fs.access(path.join("/sys/class/block", parentName));
      for (const name of await sysfsBlockAncestors(parentName, visited)) {
        names.add(name);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fallback = fallbackParentDiskName(blockName);
    if (fallback) {
      names.add(fallback);
    }
  }

  return names;
}

async function currentSystemDiskNamesFromMountInfo(): Promise<Set<string>> {
  const diskNames = new Set<string>();
  const mountInfo = await fs.readFile("/proc/self/mountinfo", "utf8");

  for (const line of mountInfo.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf(" - ");
    if (separatorIndex === -1) {
      continue;
    }

    const fields = line.slice(0, separatorIndex).split(" ");
    const mountpoint = fields[4] ? decodeMountInfoField(fields[4]) : undefined;
    if (!mountpoint || !SYSTEM_MOUNTPOINTS.has(mountpoint)) {
      continue;
    }

    const postFields = line.slice(separatorIndex + 3).split(" ");
    const source = postFields[1]
      ? decodeMountInfoField(postFields[1])
      : undefined;
    if (!source?.startsWith("/dev/")) {
      continue;
    }

    let realSource = source;
    try {
      realSource = await fs.realpath(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Some mount sources may not resolve in constrained containers; use the
      // visible source path as a conservative fallback.
    }

    const blockName = blockNameFromDevPath(realSource);
    if (!blockName) {
      continue;
    }

    for (const name of await sysfsBlockAncestors(blockName)) {
      diskNames.add(name);
    }
  }

  return diskNames;
}

function parseLsblkOutput(stdout: string): LsblkOutput {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    if (!record(parsed) || !Array.isArray(parsed.blockdevices)) {
      throw new Error("Missing block-device inventory.");
    }
    const validate = (value: unknown): void => {
      if (
        !record(value) ||
        typeof value.name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/.test(value.name) ||
        typeof value.type !== "string" ||
        !value.type ||
        !["number", "string"].includes(typeof value.size) ||
        !Number.isSafeInteger(Number(value.size)) ||
        Number(value.size) < 0
      ) {
        throw new Error("Invalid block-device identity or size.");
      }
      const mounts = value.mountpoints;
      if (
        !Array.isArray(mounts) ||
        mounts.some((mount) => mount !== null && typeof mount !== "string")
      ) {
        throw new Error(`Missing or invalid mount state for ${value.name}.`);
      }
      for (const key of ["model", "serial", "wwn", "tran"]) {
        if (
          value[key] !== undefined &&
          value[key] !== null &&
          typeof value[key] !== "string"
        ) {
          throw new Error(`Invalid ${key} for ${value.name}.`);
        }
      }
      if (value.children !== undefined) {
        if (!Array.isArray(value.children))
          throw new Error("Invalid child-device inventory.");
        value.children.forEach(validate);
      }
    };
    parsed.blockdevices.forEach(validate);
    return parsed as unknown as LsblkOutput;
  } catch (error) {
    throw new LsblkParseError(
      stdout,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function busForLsblkDevice(device: LsblkDevice): RemovableDrive["bus"] {
  if (device.tran === "usb") {
    return "usb";
  }
  if (device.tran === "mmc" || device.tran === "sd") {
    return "sd";
  }
  return "unknown";
}

function removableDriveFromLsblkDevice(
  device: LsblkDevice,
  systemDiskNames: Set<string>,
): RemovableDrive {
  const removable = isRemovable(device);
  const kernelDeviceIdentity =
    /^\d+:\d+$/.test(device["maj:min"] ?? "") &&
    Number.isSafeInteger(device["disk-seq"]) &&
    (device["disk-seq"] ?? 0) > 0 &&
    (device["log-sec"] === 512 || device["log-sec"] === 4096)
      ? `${device["maj:min"]}:${device["disk-seq"]}:${device["log-sec"]}`
      : undefined;
  const systemMountpoint = currentSystemMountpoint(device);
  const isCurrentSystemDevice = systemDiskNames.has(device.name);
  const description = [
    device.tran ? `transport: ${device.tran}` : null,
    systemMountpoint ? `current system mount: ${systemMountpoint}` : null,
    isCurrentSystemDevice ? "current system device" : null,
  ].filter((part): part is string => part !== null);

  const entry: RemovableDrive = {
    id: device.name,
    name: device.model ?? device.name,
    devicePath: `/dev/${device.name}`,
    sizeBytes: Number(device.size),
    bus: busForLsblkDevice(device),
    platform: "linux",
    safety:
      removable &&
      kernelDeviceIdentity &&
      !systemMountpoint &&
      !isCurrentSystemDevice
        ? "safe-removable"
        : "blocked-system",
  };
  if (kernelDeviceIdentity) entry.kernelDeviceIdentity = kernelDeviceIdentity;
  if (description.length > 0) {
    entry.description = description.join("; ");
  }
  const hardwareIdentity = device.wwn?.trim() || device.serial?.trim();
  if (hardwareIdentity) entry.stableId = `linux:${hardwareIdentity}`;
  return entry;
}

function pendingSteps(): InstallerStep[] {
  return (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
    detail: "Waiting to start.",
  }));
}

// Parse dd stderr progress lines: "1234567890 bytes (1.2 GB, 1.1 GiB) copied, ..."
function parseDdBytesWritten(line: string): number | null {
  const match = line.match(/(\d+)\s+bytes/);
  if (match?.[1]) return Number(match[1]);
  return null;
}

// For a multi-line buffer (entire dd stderr), grab the LAST "<n> bytes" count.
// The single-line parser above only matches the first occurrence, which would
// return a stale early-progress value when applied to the full transcript.
function parseDdLastBytesWritten(buffer: string): number | null {
  const matches = buffer.match(/(\d+)\s+bytes/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  const m = last?.match(/(\d+)/);
  return m?.[1] ? Number(m[1]) : null;
}

export interface PrivilegeEscalator {
  command: string;
  argsPrefix: string[];
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync("command", ["-v", command]);
    return true;
  } catch {
    try {
      await execFileAsync("which", [command]);
      return true;
    } catch {
      return false;
    }
  }
}

export interface PrivilegeEscalatorProbes {
  hasCommand?: (cmd: string) => Promise<boolean>;
  sudoNonInteractiveOk?: () => Promise<boolean>;
}

async function defaultSudoNonInteractiveOk(): Promise<boolean> {
  try {
    await execFileAsync("sudo", ["-n", "true"]);
    return true;
  } catch {
    return false;
  }
}

export async function findPrivilegeEscalator(
  env: NodeJS.ProcessEnv = process.env,
  probes: PrivilegeEscalatorProbes = {},
): Promise<PrivilegeEscalator> {
  const hasCommand = probes.hasCommand ?? commandExists;
  const sudoOk = probes.sudoNonInteractiveOk ?? defaultSudoNonInteractiveOk;

  // 1. pkexec — GUI prompt on GNOME/polkit
  if (await hasCommand("pkexec")) {
    return { command: "pkexec", argsPrefix: [] };
  }

  // 2. sudo -n — only works if credentials are cached, no prompt
  if (await hasCommand("sudo")) {
    if (await sudoOk()) {
      return { command: "sudo", argsPrefix: ["-n"] };
    }
    if (env.ELIZA_USB_ALLOW_SUDO === "1") {
      return { command: "sudo", argsPrefix: [] };
    }
  }

  // 3. kdesu — KDE GUI prompt
  if (await hasCommand("kdesu")) {
    return { command: "kdesu", argsPrefix: ["-c"] };
  }

  // 4. doas — minimal BSD-style escalation
  if (await hasCommand("doas")) {
    return { command: "doas", argsPrefix: [] };
  }

  throw new NoPrivilegeEscalatorError(
    [
      "No privilege escalator found. Install one of:",
      "  - pkexec (GNOME):   sudo apt install policykit-1   |   sudo dnf install polkit",
      "  - kdesu  (KDE):     sudo apt install kde-cli-tools |   sudo dnf install kde-cli-tools",
      "  - doas:             sudo apt install doas          |   sudo pacman -S opendoas",
      "  - sudo (cached):    run `sudo -v` first, or set ELIZA_USB_ALLOW_SUDO=1",
    ].join("\n"),
  );
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface LinuxBackendDeps {
  /** Absolute path to the packaged native Linux writer. */
  rawWriterPath?: string;
  /** Override the privilege escalator probe (defaults to `findPrivilegeEscalator`). */
  findEscalator?: () => Promise<PrivilegeEscalator>;
  /** Override `execFile` for lsblk/umount/sync calls. */
  execFile?: (
    command: string,
    args: readonly string[],
  ) => Promise<ExecFileResult>;
  /** Override `spawn` for the dd subprocess. Must return a ChildProcess-like with stderr emitter and on('close'|'error') support. */
  spawn?: (
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ) => ChildProcess;
  /** Override the resolve-image step (download/access check). Default: real fs+http. */
  resolveImage?: (
    image: ElizaOsImage,
    imagePath: string,
    onProgress: (pct: number) => void,
  ) => Promise<void>;
  /** Override the checksum step. Default: sha256 of the file. */
  verifyChecksum?: (image: ElizaOsImage, imagePath: string) => Promise<void>;
  /** Heartbeat interval for dd stalls. Default 1000ms. */
  heartbeatIntervalMs?: number;
  /** Heartbeat stall threshold. Default 5000ms. */
  heartbeatStallMs?: number;
  /** Override current root/live disk detection for tests. */
  currentSystemDiskNames?: () => Promise<Set<string>>;
  /** Override the canonical raw.zst streaming writer for boundary tests. */
  writeCanonicalRawImage?: (
    image: ElizaOsImage,
    drive: RemovableDrive,
    onProgress: (step: InstallerStepId, progress: number) => void,
    options?: WriteExecutionOptions,
  ) => Promise<void>;
}

function childCompletion(process: ChildProcess, label: string): Promise<void> {
  let stderr = "";
  let childError: Error | undefined;
  process.stderr?.on("data", (chunk: Buffer) => {
    const remaining = 16_384 - stderr.length;
    if (remaining > 0) stderr += chunk.toString().slice(0, remaining);
  });
  return new Promise((resolve, reject) => {
    // `close` is the authoritative lifecycle boundary: Node emits it after
    // either exit or spawn/error and after stdio has closed. Recording `error`
    // without settling here prevents a kill/send failure from unlocking the
    // target while a privileged descendant can still be alive.
    process.once("error", (error) => {
      childError = error;
    });
    process.once("close", (code) => {
      if (childError) {
        reject(childError);
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${label} exited with code ${code ?? "?"}: ${stderr.trim().slice(0, 16_384)}`,
          ),
        );
      }
    });
  });
}

interface TrackedChild {
  child: ChildProcess;
  completion: Promise<void>;
  settled: boolean;
}

function signalChildProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (
    process.platform !== "win32" &&
    Number.isSafeInteger(child.pid) &&
    (child.pid ?? 0) > 0
  ) {
    try {
      process.kill(-(child.pid as number), signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      // Fall through to the direct child when a constrained host prevents a
      // process-group signal. sudo/pkexec/doas are responsible for forwarding
      // this signal to the privileged command they supervise.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cleanup waits for the authoritative close/error event. If the wrapper
    // cannot be signalled directly, do not falsely report it as terminated.
  }
}

async function terminateTrackedChildren(
  children: Set<TrackedChild>,
): Promise<void> {
  const snapshot = [...children].filter((tracked) => !tracked.settled);
  if (snapshot.length === 0) return;

  for (const { child } of snapshot) {
    // Closing the streams also stops an elevated helper we cannot signal by UID.
    child.stdin?.destroy();
    child.stdout?.destroy();
    signalChildProcessGroup(child, "SIGTERM");
  }
  const completed = Promise.allSettled(
    snapshot.map(({ completion }) => completion),
  );
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = await Promise.race([
    completed.then(() => false),
    new Promise<true>((resolve) => {
      graceTimer = setTimeout(() => resolve(true), 2_000);
    }),
  ]);
  if (graceTimer) clearTimeout(graceTimer);
  if (graceExpired) {
    for (const tracked of snapshot) {
      if (!tracked.settled) signalChildProcessGroup(tracked.child, "SIGKILL");
    }
  }
  // Do not report a terminal cancellation or release the target lock until
  // every privileged wrapper/readback child has confirmed close/error.
  await completed;
}

function linuxRawWriterArguments(
  image: ElizaOsImage,
  drive: RemovableDrive,
  rawWriterPath: string,
): string[] {
  const identity = drive.kernelDeviceIdentity?.match(
    /^(0|[1-9]\d*):(0|[1-9]\d*):([1-9]\d*):(512|4096)$/,
  );
  const [, major, minor, diskseq, sector] = identity ?? [];
  if (
    !major ||
    !minor ||
    !diskseq ||
    !sector ||
    !Number.isSafeInteger(drive.sizeBytes) ||
    !Number.isSafeInteger(image.expandedSize)
  ) {
    throw new Error(
      "Raw Linux writes require the selected kernel device identity and exact image size.",
    );
  }
  if (!path.isAbsolute(rawWriterPath))
    throw new Error("Native writer path must be absolute.");
  return [
    rawWriterPath,
    drive.devicePath,
    major,
    minor,
    diskseq,
    String(drive.sizeBytes),
    sector,
    String(image.expandedSize),
  ];
}

export async function writeCanonicalRawImageToLinuxDevice(
  image: ElizaOsImage,
  drive: RemovableDrive,
  escalator: PrivilegeEscalator,
  spawnFn: (
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ) => ChildProcess,
  onProgress: (step: InstallerStepId, progress: number) => void,
  rawWriter: typeof writeVerifiedRawImage = writeVerifiedRawImage,
  options: WriteExecutionOptions = {},
  rawWriterPath = DEFAULT_RAW_WRITER,
): Promise<void> {
  if (escalator.command === "kdesu") {
    throw new Error(
      "Canonical raw.zst streaming requires pkexec, sudo, or doas; kdesu cannot safely preserve the binary stream.",
    );
  }

  const writerArgs = linuxRawWriterArguments(image, drive, rawWriterPath);
  let synced: Promise<void> | undefined;
  let writeProcess: TrackedChild | undefined;
  const activeChildren = new Set<TrackedChild>();
  const trackChild = (child: ChildProcess, label: string): TrackedChild => {
    const tracked: TrackedChild = {
      child,
      completion: Promise.resolve(),
      settled: false,
    };
    tracked.completion = childCompletion(child, label).finally(() => {
      tracked.settled = true;
      activeChildren.delete(tracked);
    });
    // Observe rejection immediately; the owning operation awaits the same
    // promise at sync/readback or during cleanup and still receives the error.
    void tracked.completion.catch(() => {});
    activeChildren.add(tracked);
    return tracked;
  };
  let termination = Promise.resolve();
  const requestTermination = () => {
    // Run a fresh sweep every time. An abort can race the transition from
    // download to privileged spawn; the catch-path sweep must include children
    // that appeared after the signal handler's initial empty snapshot.
    termination = termination.then(() =>
      terminateTrackedChildren(activeChildren),
    );
    return termination;
  };
  const onAbort = () => {
    void requestTermination().catch(() => {});
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const target: RawImageTarget = {
    stableId: drive.stableId ?? drive.devicePath,
    capacityBytes: drive.sizeBytes,
    openWriteStream() {
      if (writeProcess)
        throw new Error("Raw image write stream was opened twice.");
      const child = spawnFn(
        escalator.command,
        [...escalator.argsPrefix, ...writerArgs],
        { detached: process.platform !== "win32" },
      );
      writeProcess = trackChild(
        child,
        "privileged raw image write and readback",
      );
      if (!child.stdin) {
        throw new Error("Privileged raw image writer did not expose stdin.");
      }
      child.stdin.once("close", () => {
        if (!child.stdin?.writableFinished) {
          signalChildProcessGroup(child, "SIGTERM");
        }
      });
      const completion = writeProcess.completion;
      synced = new Promise<void>((resolve, reject) => {
        let pending = "";
        const onData = (chunk: Buffer) => {
          pending += chunk.toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          if (pending.length > 16_384) {
            child.stderr?.off("data", onData);
            reject(
              new Error("Native writer status exceeded its protocol bound."),
            );
          } else if (lines.includes("ELIZAOS_RAW_SYNCED")) {
            child.stderr?.off("data", onData);
            resolve();
          }
        };
        child.stderr?.on("data", onData);
        void completion.then(
          () =>
            reject(new Error("Native writer exited before confirming sync.")),
          reject,
        );
      });
      void synced.catch(() => {});
      return child.stdin;
    },
    openReadbackStream(byteLength: number) {
      if (!writeProcess || byteLength !== image.expandedSize)
        throw new Error("Invalid retained-device readback.");
      const stdout = writeProcess.child.stdout;
      if (!stdout)
        throw new Error("Native writer did not expose readback stdout.");
      const completion = writeProcess.completion;
      return Readable.from(
        (async function* verifiedReadback() {
          for await (const chunk of stdout) yield chunk;
          await completion;
        })(),
      );
    },
    async sync() {
      if (!synced) throw new Error("Raw image write never started.");
      await synced;
    },
  };

  onProgress("resolve-image", 0);
  onProgress("checksum", 0);
  onProgress("write", 0);
  onProgress("verify", 0);
  try {
    await rawWriter(image, target, {
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress(phase, completed, total) {
        const progress = total > 0 ? Math.min(completed / total, 1) : 0;
        if (phase === "download") {
          onProgress("resolve-image", progress);
          if (progress === 1) onProgress("checksum", 1);
        } else if (phase === "decompress-write") {
          onProgress("write", progress);
        } else {
          onProgress("verify", progress);
        }
      },
    });
  } catch (error) {
    await requestTermination();
    if (options.signal?.aborted) throw new WriteCancelledError();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
  onProgress("resolve-image", 1);
  onProgress("checksum", 1);
  onProgress("write", 1);
  onProgress("verify", 1);
}

export class LinuxUsbInstallerBackend implements UsbInstallerBackend {
  readonly canonicalRawZstdSupported = true;
  readonly canonicalWriteCancellationSupported = true;
  private readonly deps: LinuxBackendDeps;

  constructor(deps: LinuxBackendDeps = {}) {
    this.deps = deps;
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const execFileFn =
      this.deps.execFile ??
      (async (cmd: string, args: readonly string[]) => {
        const r = await execFileAsync(cmd, [...args]);
        return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      });

    const { stdout } = await execFileFn("lsblk", [
      "--json",
      "--output",
      "NAME,SIZE,TYPE,RM,MODEL,SERIAL,WWN,TRAN,HOTPLUG,MOUNTPOINTS,MAJ:MIN,DISK-SEQ,LOG-SEC",
      "--bytes",
    ]);

    const parsed = parseLsblkOutput(stdout);
    const systemDiskNames = this.deps.currentSystemDiskNames
      ? await this.deps.currentSystemDiskNames()
      : await currentSystemDiskNamesFromMountInfo();

    return parsed.blockdevices
      .filter((device) => device.type === "disk")
      .map((device) => removableDriveFromLsblkDevice(device, systemDiskNames));
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return fetchReleaseImages();
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    const [drives, images] = await Promise.all([
      this.listRemovableDrives(),
      this.listImages(),
    ]);

    const drive = drives.find((d) => d.id === request.driveId);
    if (!drive) throw new Error(`Unknown drive id: ${request.driveId}`);
    assertDriveMatchesExpected(request, drive);

    const image = images.find((img) => img.id === request.imageId);
    if (!image) throw new Error(`Unknown image id: ${request.imageId}`);

    if (!request.acknowledgeDataLoss) {
      throw new Error(
        "Data-loss acknowledgement is required before preparing media.",
      );
    }

    const blockedReason =
      drive.safety !== "safe-removable"
        ? "the target is not marked safe-removable."
        : drive.sizeBytes < image.minUsbSizeBytes
          ? `the target is ${Math.round(drive.sizeBytes / 1024 ** 3)} GiB but ${Math.round(image.minUsbSizeBytes / 1024 ** 3)} GiB is required.`
          : null;

    const steps: InstallerStep[] = blockedReason
      ? (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
          id,
          label: STEP_LABELS[id],
          status: "blocked",
          detail: `Blocked: ${blockedReason}`,
        }))
      : request.dryRun
        ? (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
            id,
            label: STEP_LABELS[id],
            status: "complete",
            detail: "Dry-run complete; no bytes were written.",
          }))
        : pendingSteps();

    return {
      request,
      drive,
      image,
      steps,
      privilegedWriteImplemented: true,
    };
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (step: InstallerStepId, progress: number) => void,
    options: WriteExecutionOptions = {},
  ): Promise<void> {
    plan = structuredClone(plan);
    options.signal?.throwIfAborted();
    assertWritePlanAllowed(plan, { canonicalRawZstdSupported: true });

    const { image, drive } = plan;
    const isCanonicalRawImage = image.format === "raw.zst";
    if (isCanonicalRawImage && !this.deps.writeCanonicalRawImage) {
      const helper = this.deps.rawWriterPath ?? DEFAULT_RAW_WRITER;
      linuxRawWriterArguments(image, drive, helper);
      // Refuse a missing packaged helper before privilege prompts or unmounts.
      await fs.access(helper, constants.X_OK);
    }

    const execFileFn =
      this.deps.execFile ??
      (async (cmd: string, args: readonly string[]) => {
        const r = await execFileAsync(cmd, [...args]);
        return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      });
    const spawnFn =
      this.deps.spawn ??
      ((
        command: string,
        args: readonly string[],
        spawnOptions?: SpawnOptions,
      ) =>
        spawnOptions
          ? spawn(command, [...args], spawnOptions)
          : spawn(command, [...args]));
    const findEscalatorFn = this.deps.findEscalator ?? findPrivilegeEscalator;
    const heartbeatInterval = this.deps.heartbeatIntervalMs ?? 1_000;
    const heartbeatStall = this.deps.heartbeatStallMs ?? 5_000;

    // Probe for a privilege escalator BEFORE any side effects (download,
    // checksum, umount). Failing late would leave the device in a partially
    // unmounted state with no path to recover.
    const escalator = await findEscalatorFn();
    options.signal?.throwIfAborted();

    await withTemporaryImageDirectory(async (directory) => {
      const imagePath = path.join(directory, `${image.checksumSha256}.iso`);
      if (!isCanonicalRawImage) {
        // Legacy ISO path. Canonical raw.zst inputs are never materialized under
        // an .iso name or passed to the unverified direct-dd path below.
        onProgress("resolve-image", 0);
        if (this.deps.resolveImage) {
          await this.deps.resolveImage(image, imagePath, (pct) =>
            onProgress("resolve-image", pct),
          );
        } else {
          await downloadFile(
            image.url,
            imagePath,
            image.sizeBytes,
            (received, total) => {
              const pct = total > 0 ? received / total : 0;
              onProgress("resolve-image", pct);
            },
            options.signal,
          );
        }
        onProgress("resolve-image", 1);

        onProgress("checksum", 0);
        if (this.deps.verifyChecksum) {
          await this.deps.verifyChecksum(image, imagePath);
        } else {
          const actual = await sha256File(imagePath);
          if (actual !== image.checksumSha256) {
            throw new Error(
              `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
            );
          }
        }
        onProgress("checksum", 1);
      }

      // Unmount all mounted partitions of the target disk. A busy/failed
      // unmount must abort the write — dd into a mounted FS corrupts data.
      options.signal?.throwIfAborted();
      const { stdout: childStdout } = await execFileFn("lsblk", [
        "--json",
        "--output",
        "NAME,PKNAME,TYPE,MOUNTPOINT",
        drive.devicePath,
      ]);
      let mountedPartitions: string[];
      try {
        const childData = JSON.parse(childStdout);
        const devices = childData?.blockdevices;
        if (!Array.isArray(devices) || devices.length !== 1) {
          throw new Error("Expected exactly one selected disk.");
        }
        const target = devices[0];
        if (
          target?.name !== path.basename(drive.devicePath) ||
          target.type !== "disk" ||
          target.mountpoint !== null ||
          (target.children !== undefined && !Array.isArray(target.children))
        ) {
          throw new Error("Selected disk identity or mount state is invalid.");
        }
        const seen = new Set<string>();
        mountedPartitions = [];
        for (const child of target.children ?? []) {
          if (
            child?.type !== "part" ||
            child.pkname !== target.name ||
            typeof child.name !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/.test(child.name) ||
            child.name === target.name ||
            seen.has(child.name) ||
            (child.mountpoint !== null &&
              typeof child.mountpoint !== "string") ||
            (child.children !== undefined &&
              (!Array.isArray(child.children) || child.children.length > 0))
          ) {
            throw new Error("Invalid or stacked target partition inventory.");
          }
          if (
            child.mountpoint !== null &&
            SYSTEM_MOUNTPOINTS.has(child.mountpoint)
          ) {
            throw new Error("Selected disk contains a current system mount.");
          }
          seen.add(child.name);
          if (child.mountpoint) mountedPartitions.push(`/dev/${child.name}`);
        }
      } catch (error) {
        throw new LsblkParseError(
          childStdout,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      for (const partPath of mountedPartitions) {
        options.signal?.throwIfAborted();
        try {
          await execFileFn(escalator.command, [
            ...escalator.argsPrefix,
            "umount",
            partPath,
          ]);
        } catch (err) {
          const e = err as { stderr?: string; message?: string };
          throw new UnmountFailedError(
            partPath,
            e.stderr?.trim() || e.message || "unknown error",
          );
        }
      }

      options.signal?.throwIfAborted();
      if (isCanonicalRawImage) {
        const writer = this.deps.writeCanonicalRawImage;
        if (writer) {
          await writer(image, drive, onProgress, options);
        } else {
          await writeCanonicalRawImageToLinuxDevice(
            image,
            drive,
            escalator,
            spawnFn,
            onProgress,
            writeVerifiedRawImage,
            options,
            this.deps.rawWriterPath,
          );
        }
        return;
      }

      // Step: write using a privilege escalator + dd with progress
      onProgress("write", 0);
      let finalBytesWritten = 0;
      await new Promise<void>((resolve, reject) => {
        const ddArgs = [
          "dd",
          `if=${imagePath}`,
          `of=${drive.devicePath}`,
          "bs=4M",
          "status=progress",
          "conv=fsync",
        ];
        const proc = spawnFn(escalator.command, [
          ...escalator.argsPrefix,
          ...ddArgs,
        ]);

        let lastProgress = 0;
        let lastProgressAt = Date.now();
        // Heartbeat: if dd output is buffered and no update arrives for >stall,
        // re-emit the last known progress so the UI knows we are still alive.
        const heartbeat = setInterval(() => {
          if (Date.now() - lastProgressAt >= heartbeatStall) {
            onProgress("write", lastProgress);
            lastProgressAt = Date.now();
          }
        }, heartbeatInterval);

        let stderrBuf = "";
        let stderrAll = "";
        let processError: Error | undefined;
        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderrAll += text;
          stderrBuf += text;
          const segments = stderrBuf.split(/[\r\n]/);
          stderrBuf = segments.pop() ?? "";
          for (const seg of segments) {
            const bytes = parseDdBytesWritten(seg);
            if (bytes !== null) {
              finalBytesWritten = bytes;
              if (image.sizeBytes > 0) {
                const pct = Math.min(bytes / image.sizeBytes, 0.99);
                lastProgress = pct;
                lastProgressAt = Date.now();
                onProgress("write", pct);
              }
            }
          }
        });

        proc.on("close", (code) => {
          clearInterval(heartbeat);
          // Final dd summary line lives in stderrBuf or stderrAll.
          const tailBytes =
            parseDdBytesWritten(stderrBuf) ??
            parseDdLastBytesWritten(stderrAll);
          if (tailBytes !== null) {
            finalBytesWritten = tailBytes;
          }
          if (processError) {
            reject(processError);
          } else if (code === 0) {
            resolve();
          } else {
            reject(new Error(`dd exited with code ${code ?? "?"}`));
          }
        });
        proc.on("error", (err) => {
          // Keep ownership until close confirms the child and stdio settled.
          processError = err;
        });
      });

      if (finalBytesWritten !== image.sizeBytes) {
        throw new WriteIncompleteError(image.sizeBytes, finalBytesWritten);
      }
      onProgress("write", 1);

      // Step: verify (sync)
      onProgress("verify", 0);
      await execFileFn("sync", []);
      onProgress("verify", 1);
    });
    onProgress("complete", 1);
  }
}
