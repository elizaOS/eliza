import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_ELIZAOS_IMAGES } from "./dry-run-backend";
import {
  LsblkParseError,
  NoPrivilegeEscalatorError,
  UnmountFailedError,
  WriteIncompleteError,
} from "./errors";
import type {
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
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
  verify: "Verify media",
  complete: "Complete",
};

const INSTALLER_TMP_DIR = "/tmp/elizaos-installer";

interface LsblkDevice {
  name: string;
  size: string;
  type: string;
  rm: boolean | string;
  model: string | null;
  tran: string | null;
  hotplug: boolean | string;
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

async function fetchGitHubIsoImages(): Promise<ElizaOsImage[]> {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.github.com/repos/elizaos/eliza/releases",
      { headers: { "User-Agent": "elizaos-usb-installer/1.0" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const releases = JSON.parse(body) as Array<{
              tag_name: string;
              published_at: string;
              prerelease: boolean;
              assets: Array<{
                name: string;
                browser_download_url: string;
                size: number;
              }>;
            }>;

            const images: ElizaOsImage[] = [];
            for (const release of releases) {
              for (const asset of release.assets) {
                if (!asset.name.endsWith(".iso")) continue;
                const arch: ElizaOsImage["architecture"] = asset.name.includes(
                  "riscv64",
                )
                  ? "riscv64"
                  : asset.name.includes("arm64")
                    ? "arm64"
                    : "x86_64";
                const channel: ElizaOsImage["channel"] = release.prerelease
                  ? "nightly"
                  : "stable";
                images.push({
                  id: `github-${release.tag_name}-${asset.name}`,
                  label: `elizaOS ${release.tag_name}`,
                  version: release.tag_name,
                  channel,
                  architecture: arch,
                  buildId: release.tag_name,
                  publishedAt: release.published_at,
                  url: asset.browser_download_url,
                  checksumSha256:
                    "0000000000000000000000000000000000000000000000000000000000000000",
                  sizeBytes: asset.size,
                  minUsbSizeBytes: Math.max(asset.size * 1.2, 8 * 1024 ** 3),
                  manifestVersion: 1,
                });
              }
            }
            resolve(images.length > 0 ? images : DEFAULT_ELIZAOS_IMAGES);
          } catch {
            resolve(DEFAULT_ELIZAOS_IMAGES);
          }
        });
        res.on("error", () => resolve(DEFAULT_ELIZAOS_IMAGES));
      },
    );
    req.on("error", () => resolve(DEFAULT_ELIZAOS_IMAGES));
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  return new Promise((resolve, reject) => {
    function doRequest(requestUrl: string): void {
      const protocol = requestUrl.startsWith("https://") ? https : http;
      protocol
        .get(
          requestUrl,
          { headers: { "User-Agent": "elizaos-usb-installer/1.0" } },
          (res) => {
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const location = res.headers.location;
              if (!location) {
                reject(
                  new Error(
                    `Redirect with no location header from ${requestUrl}`,
                  ),
                );
                return;
              }
              doRequest(location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `HTTP ${res.statusCode ?? "?"} downloading ${requestUrl}`,
                ),
              );
              return;
            }
            const total = Number(res.headers["content-length"] ?? 0);
            let received = 0;
            const writeStream = require("node:fs").createWriteStream(destPath);
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              onProgress(received, total);
            });
            res.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
            res.on("error", reject);
          },
        )
        .on("error", reject);
    }
    doRequest(url);
  });
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
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
    if (env.MILADY_USB_ALLOW_SUDO === "1") {
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
      "  - sudo (cached):    run `sudo -v` first, or set MILADY_USB_ALLOW_SUDO=1",
    ].join("\n"),
  );
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface LinuxBackendDeps {
  /** Override the privilege escalator probe (defaults to `findPrivilegeEscalator`). */
  findEscalator?: () => Promise<PrivilegeEscalator>;
  /** Override `execFile` for lsblk/umount/sync calls. */
  execFile?: (
    command: string,
    args: readonly string[],
  ) => Promise<ExecFileResult>;
  /** Override `spawn` for the dd subprocess. Must return a ChildProcess-like with stderr emitter and on('close'|'error') support. */
  spawn?: (command: string, args: readonly string[]) => ChildProcess;
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
}

export class LinuxUsbInstallerBackend implements UsbInstallerBackend {
  private readonly deps: LinuxBackendDeps;

  constructor(deps: LinuxBackendDeps = {}) {
    this.deps = deps;
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const { stdout } = await execFileAsync("lsblk", [
      "--json",
      "--output",
      "NAME,SIZE,TYPE,RM,MODEL,TRAN,HOTPLUG",
      "--bytes",
    ]);

    let parsed: LsblkOutput;
    try {
      parsed = JSON.parse(stdout) as LsblkOutput;
    } catch (error) {
      throw new LsblkParseError(
        stdout,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const drives: RemovableDrive[] = [];

    for (const device of parsed.blockdevices) {
      if (device.type !== "disk") continue;

      const removable = isRemovable(device);
      const isUsb = device.tran === "usb";
      const bus: RemovableDrive["bus"] = isUsb
        ? "usb"
        : device.tran === "mmc" || device.tran === "sd"
          ? "sd"
          : "unknown";

      const entry: RemovableDrive = {
        id: device.name,
        name: device.model ?? device.name,
        devicePath: `/dev/${device.name}`,
        sizeBytes: Number(device.size),
        bus,
        platform: "linux",
        safety: removable ? "safe-removable" : "blocked-system",
      };
      if (device.tran) {
        entry.description = `transport: ${device.tran}`;
      }
      drives.push(entry);
    }

    return drives;
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return fetchGitHubIsoImages();
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
  ): Promise<void> {
    assertWritePlanAllowed(plan);

    const { image, drive } = plan;
    const imagePath = path.join(INSTALLER_TMP_DIR, `${image.id}.iso`);

    const execFileFn =
      this.deps.execFile ??
      (async (cmd: string, args: readonly string[]) => {
        const r = await execFileAsync(cmd, [...args]);
        return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      });
    const spawnFn = this.deps.spawn ?? spawn;
    const findEscalatorFn = this.deps.findEscalator ?? findPrivilegeEscalator;
    const heartbeatInterval = this.deps.heartbeatIntervalMs ?? 1_000;
    const heartbeatStall = this.deps.heartbeatStallMs ?? 5_000;

    // Probe for a privilege escalator BEFORE any side effects (download,
    // checksum, umount). Failing late would leave the device in a partially
    // unmounted state with no path to recover.
    const escalator = await findEscalatorFn();

    // Step: resolve-image
    onProgress("resolve-image", 0);
    if (this.deps.resolveImage) {
      await this.deps.resolveImage(image, imagePath, (pct) =>
        onProgress("resolve-image", pct),
      );
    } else {
      let needsDownload = false;
      try {
        await fs.access(imagePath);
      } catch {
        needsDownload = true;
      }

      if (needsDownload) {
        await downloadFile(image.url, imagePath, (received, total) => {
          const pct = total > 0 ? received / total : 0;
          onProgress("resolve-image", pct);
        });
      }
    }
    onProgress("resolve-image", 1);

    // Step: checksum
    onProgress("checksum", 0);
    if (this.deps.verifyChecksum) {
      await this.deps.verifyChecksum(image, imagePath);
    } else {
      const ZEROED_CHECKSUM = "0".repeat(64);
      if (image.checksumSha256 !== ZEROED_CHECKSUM) {
        const actual = await sha256File(imagePath);
        if (actual !== image.checksumSha256) {
          throw new Error(
            `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
          );
        }
      }
    }
    onProgress("checksum", 1);

    // Unmount all mounted partitions of the target disk. A busy/failed
    // unmount must abort the write — dd into a mounted FS corrupts data.
    const { stdout: childStdout } = await execFileFn("lsblk", [
      "--json",
      "--output",
      "NAME,MOUNTPOINT",
      drive.devicePath,
    ]);
    let childData: {
      blockdevices: Array<{
        name: string;
        children?: Array<{ name: string; mountpoint?: string | null }>;
      }>;
    };
    try {
      childData = JSON.parse(childStdout);
    } catch (error) {
      throw new LsblkParseError(
        childStdout,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const targetDevice = childData.blockdevices[0];
    if (targetDevice?.children) {
      for (const child of targetDevice.children) {
        if (!child.mountpoint) continue;
        const partPath = `/dev/${child.name}`;
        try {
          await execFileFn("umount", [partPath]);
        } catch (err) {
          const e = err as { code?: number; stderr?: string };
          const stderr = e.stderr ?? "";
          // Exit code 32 / "not mounted" is acceptable (race vs. lsblk).
          if (e.code !== 32 && !/not mounted/i.test(stderr)) {
            throw new UnmountFailedError(
              partPath,
              stderr.trim() || "unknown error",
            );
          }
        }
      }
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
          parseDdBytesWritten(stderrBuf) ?? parseDdLastBytesWritten(stderrAll);
        if (tailBytes !== null) {
          finalBytesWritten = tailBytes;
        }
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`dd exited with code ${code ?? "?"}`));
        }
      });
      proc.on("error", (err) => {
        clearInterval(heartbeat);
        reject(err);
      });
    });

    if (image.sizeBytes > 0) {
      const drift = Math.abs(finalBytesWritten - image.sizeBytes);
      if (drift > 1024 * 1024) {
        throw new WriteIncompleteError(image.sizeBytes, finalBytesWritten);
      }
    }
    onProgress("write", 1);

    // Step: verify (sync)
    onProgress("verify", 0);
    await execFileFn("sync", []);
    onProgress("verify", 1);

    // Step: complete
    onProgress("complete", 1);
  }
}
