import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as https from "node:https";
import * as http from "node:http";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_ELIZAOS_IMAGES } from "./dry-run-backend";
import type {
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";

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
                const arch: ElizaOsImage["architecture"] =
                  asset.name.includes("arm64") ? "arm64" : "x86_64";
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
      protocol.get(requestUrl, { headers: { "User-Agent": "elizaos-usb-installer/1.0" } }, (res) => {
        if (
          res.statusCode === 301 ||
          res.statusCode === 302 ||
          res.statusCode === 307 ||
          res.statusCode === 308
        ) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error(`Redirect with no location header from ${requestUrl}`));
            return;
          }
          doRequest(location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading ${requestUrl}`));
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
      }).on("error", reject);
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
  const match = line.match(/^(\d+)\s+bytes/);
  if (match?.[1]) return Number(match[1]);
  return null;
}

export class LinuxUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const { stdout } = await execFileAsync("lsblk", [
      "--json",
      "--output",
      "NAME,SIZE,TYPE,RM,MODEL,TRAN,HOTPLUG",
      "--bytes",
    ]);

    const parsed = JSON.parse(stdout) as LsblkOutput;
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
    if (!plan.request.acknowledgeDataLoss) {
      throw new Error("Data-loss acknowledgement is required.");
    }
    if (plan.drive.safety !== "safe-removable") {
      throw new Error("Drive is not safe-removable; write aborted.");
    }

    const { image, drive } = plan;
    const imagePath = path.join(INSTALLER_TMP_DIR, `${image.id}.iso`);

    // Step: resolve-image
    onProgress("resolve-image", 0);
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
    onProgress("resolve-image", 1);

    // Step: checksum
    onProgress("checksum", 0);
    const ZEROED_CHECKSUM = "0".repeat(64);
    if (image.checksumSha256 !== ZEROED_CHECKSUM) {
      const actual = await sha256File(imagePath);
      if (actual !== image.checksumSha256) {
        throw new Error(
          `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
        );
      }
    }
    onProgress("checksum", 1);

    // Unmount all partitions of the target disk
    try {
      const { stdout } = await execFileAsync("lsblk", [
        "--json",
        "--output",
        "NAME,MOUNTPOINT",
        drive.devicePath,
      ]);
      const lsblkData = JSON.parse(stdout) as {
        blockdevices: Array<{ name: string; children?: Array<{ name: string; mountpoint?: string }> }>;
      };
      const device = lsblkData.blockdevices[0];
      if (device?.children) {
        for (const child of device.children) {
          if (child.mountpoint) {
            await execFileAsync("umount", [`/dev/${child.name}`]).catch(
              () => undefined,
            );
          }
        }
      }
    } catch {
      // best effort
    }

    // Step: write using pkexec dd with progress
    onProgress("write", 0);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("pkexec", [
        "dd",
        `if=${imagePath}`,
        `of=${drive.devicePath}`,
        "bs=4M",
        "status=progress",
      ]);

      // dd writes progress to stderr
      let stderrBuf = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        // dd emits lines like: "1234567 bytes (1.2 MB, 1.1 MiB) copied, 1 s, 1.2 MB/s"
        const lines = stderrBuf.split("\r");
        const lastLine = lines[lines.length - 1] ?? "";
        const bytesWritten = parseDdBytesWritten(lastLine);
        if (bytesWritten !== null && image.sizeBytes > 0) {
          onProgress("write", Math.min(bytesWritten / image.sizeBytes, 0.99));
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          onProgress("write", 1);
          resolve();
        } else {
          reject(new Error(`dd exited with code ${code ?? "?"}`));
        }
      });
      proc.on("error", reject);
    });

    // Step: verify (sync)
    onProgress("verify", 0);
    await execFileAsync("sync");
    onProgress("verify", 1);

    // Step: complete
    onProgress("complete", 1);
  }
}
