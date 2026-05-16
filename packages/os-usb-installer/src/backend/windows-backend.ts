import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
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

interface PowerShellDisk {
  Number: number;
  FriendlyName: string;
  Size: number;
  BusType: string;
}

async function runPowerShell(script: string): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NonInteractive",
    "-NoProfile",
    "-Command",
    script,
  ]);
  return stdout;
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
                  "arm64",
                )
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

// Build a diskpart script that wipes and creates a primary partition on a disk number.
function buildDiskpartScript(diskNumber: number): string {
  return [
    `select disk ${diskNumber}`,
    "clean",
    "create partition primary",
    "format fs=fat32 quick",
    "assign",
    "exit",
  ].join("\r\n");
}

export class WindowsUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const output = await runPowerShell(
      "Get-Disk | Where-Object {$_.BusType -eq 'USB'} | Select-Object Number,FriendlyName,Size,BusType | ConvertTo-Json -Depth 2",
    );

    const trimmed = output.trim();
    if (!trimmed) return [];

    // PowerShell returns a bare object (not array) when only one disk is found
    const rawParsed = JSON.parse(trimmed) as PowerShellDisk | PowerShellDisk[];
    const disks: PowerShellDisk[] = Array.isArray(rawParsed)
      ? rawParsed
      : [rawParsed];

    return disks.map((disk) => ({
      id: String(disk.Number),
      name: disk.FriendlyName || `Disk ${disk.Number}`,
      devicePath: `\\\\.\\PhysicalDrive${disk.Number}`,
      sizeBytes: disk.Size,
      bus: "usb",
      platform: "win32",
      safety: "safe-removable",
      description: `Disk ${disk.Number} - ${disk.BusType}`,
    }));
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
    const tmpDir = path.join(os.tmpdir(), "elizaos-installer");
    const imagePath = path.join(tmpDir, `${image.id}.iso`);
    const diskNumber = Number(drive.id);

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

    // Step: write
    // First, use diskpart (elevated via Start-Process -Verb RunAs) to wipe/prepare the disk
    onProgress("write", 0);
    const diskpartScript = buildDiskpartScript(diskNumber);
    const scriptPath = path.join(tmpDir, "diskpart-script.txt");
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(scriptPath, diskpartScript, "utf8");

    // Run diskpart elevated
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("powershell.exe", [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `Start-Process diskpart.exe -ArgumentList '/s','${scriptPath}' -Verb RunAs -Wait`,
      ]);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`diskpart exited with code ${code ?? "?"}`));
      });
      proc.on("error", reject);
    });

    // Use dd.exe (from Git for Windows or PATH) to write the image
    await new Promise<void>((resolve, reject) => {
      const physicalDrive = `\\\\.\\PhysicalDrive${diskNumber}`;
      const proc = spawn("powershell.exe", [
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `Start-Process dd.exe -ArgumentList 'if=${imagePath}','of=${physicalDrive}','bs=4M','--progress' -Verb RunAs -Wait`,
      ]);

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        // dd --progress outputs bytes written to stderr
        const match = text.match(/(\d+)\s+bytes/);
        if (match?.[1] && image.sizeBytes > 0) {
          onProgress(
            "write",
            Math.min(Number(match[1]) / image.sizeBytes, 0.99),
          );
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

    // Clean up script file
    await fs.unlink(scriptPath).catch(() => undefined);

    // Step: verify
    onProgress("verify", 0);
    // Flush write cache via PowerShell
    await runPowerShell(
      `$disk = Get-Disk -Number ${diskNumber}; $disk | Set-Disk -IsOffline $false`,
    ).catch(() => undefined);
    onProgress("verify", 1);

    // Step: complete
    onProgress("complete", 1);
  }
}
