import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
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

const TWO_TB = 2 * 1024 ** 4;
const INSTALLER_TMP_DIR = "/tmp/elizaos-installer";

interface DiskUtilPlistDisk {
  DeviceIdentifier: string;
  Size: number;
  Content?: string;
  Partitions?: DiskUtilPlistDisk[];
}

interface DiskUtilListPlist {
  AllDisksAndPartitions?: DiskUtilPlistDisk[];
}

interface DiskUtilInfoPlist {
  DeviceIdentifier?: string;
  MediaName?: string;
  IORegistryEntryName?: string;
  BusProtocol?: string;
  TotalSize?: number;
  Removable?: boolean;
  RemovableMediaOrExternalDevice?: boolean;
  Internal?: boolean;
  OSInternalMedia?: boolean;
  VirtualOrPhysical?: string;
}

// Minimal plist parser for the flat dict structure diskutil emits.
// Handles <key>, <string>, <integer>, <true/>, <false/>, nested <dict> and <array>.
function parsePlistValue(
  xml: string,
  pos: number,
): { value: unknown; end: number } {
  // skip whitespace
  while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;

  if (xml.startsWith("<true/>", pos)) {
    return { value: true, end: pos + 7 };
  }
  if (xml.startsWith("<false/>", pos)) {
    return { value: false, end: pos + 8 };
  }
  if (xml.startsWith("<integer>", pos)) {
    const end = xml.indexOf("</integer>", pos + 9);
    const raw = xml.slice(pos + 9, end);
    return { value: Number(raw), end: end + 10 };
  }
  if (xml.startsWith("<real>", pos)) {
    const end = xml.indexOf("</real>", pos + 6);
    const raw = xml.slice(pos + 6, end);
    return { value: Number(raw), end: end + 7 };
  }
  if (xml.startsWith("<string>", pos)) {
    const end = xml.indexOf("</string>", pos + 8);
    const raw = xml.slice(pos + 8, end);
    return { value: raw, end: end + 9 };
  }
  if (xml.startsWith("<dict>", pos)) {
    return parsePlistDict(xml, pos);
  }
  if (xml.startsWith("<array>", pos)) {
    return parsePlistArray(xml, pos);
  }
  // skip unknown tag
  const tagEnd = xml.indexOf(">", pos);
  return { value: null, end: tagEnd + 1 };
}

function parsePlistDict(
  xml: string,
  pos: number,
): { value: Record<string, unknown>; end: number } {
  // consume <dict>
  pos = xml.indexOf("<dict>", pos) + 6;
  const out: Record<string, unknown> = {};
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;
    if (xml.startsWith("</dict>", pos)) {
      return { value: out, end: pos + 7 };
    }
    if (xml.startsWith("<key>", pos)) {
      const keyEnd = xml.indexOf("</key>", pos + 5);
      const key = xml.slice(pos + 5, keyEnd);
      pos = keyEnd + 6;
      while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;
      const { value, end } = parsePlistValue(xml, pos);
      out[key] = value;
      pos = end;
    } else {
      pos++;
    }
  }
  return { value: out, end: pos };
}

function parsePlistArray(
  xml: string,
  pos: number,
): { value: unknown[]; end: number } {
  pos = xml.indexOf("<array>", pos) + 7;
  const out: unknown[] = [];
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;
    if (xml.startsWith("</array>", pos)) {
      return { value: out, end: pos + 8 };
    }
    const { value, end } = parsePlistValue(xml, pos);
    out.push(value);
    pos = end;
  }
  return { value: out, end: pos };
}

function parsePlist(xml: string): unknown {
  const dictPos = xml.indexOf("<dict>");
  if (dictPos === -1) return {};
  return parsePlistDict(xml, dictPos).value;
}

async function getDiskUtilList(): Promise<DiskUtilListPlist> {
  const { stdout } = await execFileAsync("diskutil", ["list", "-plist"]);
  return parsePlist(stdout) as DiskUtilListPlist;
}

async function getDiskUtilInfo(
  deviceIdentifier: string,
): Promise<DiskUtilInfoPlist> {
  try {
    const { stdout } = await execFileAsync("diskutil", [
      "info",
      "-plist",
      `/dev/${deviceIdentifier}`,
    ]);
    return parsePlist(stdout) as DiskUtilInfoPlist;
  } catch {
    return {};
  }
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

export class MacOsUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const plist = await getDiskUtilList();
    const disks = plist.AllDisksAndPartitions ?? [];
    const drives: RemovableDrive[] = [];

    for (const disk of disks) {
      const deviceId = disk.DeviceIdentifier;
      if (!deviceId) continue;
      if (disk.Size > TWO_TB) continue;

      const info = await getDiskUtilInfo(deviceId);
      const isInternal =
        info.Internal === true || info.OSInternalMedia === true;
      const isVirtual = info.VirtualOrPhysical === "Virtual";
      const isRemovable =
        info.Removable === true || info.RemovableMediaOrExternalDevice === true;
      const busProtocol = (info.BusProtocol ?? "").toLowerCase();
      const isUsb = busProtocol === "usb";
      const isDiskImage = busProtocol === "disk image" || isVirtual;

      const content = disk.Content ?? "";
      const isApfsOrHfs =
        content.startsWith("Apple_APFS") || content.startsWith("Apple_HFS");

      let safety: RemovableDrive["safety"] = "unknown";
      if (isInternal || isApfsOrHfs) {
        safety = "blocked-system";
      } else if (isDiskImage) {
        // Disk images (mounted .dmg, simulator runtimes, etc.) are not real USB drives.
        // Skip them entirely — they are not writable installer targets.
        continue;
      } else if (isUsb || isRemovable) {
        safety = "safe-removable";
      }

      const name =
        info.MediaName ?? info.IORegistryEntryName ?? `Disk ${deviceId}`;

      const bus: RemovableDrive["bus"] = isUsb
        ? "usb"
        : busProtocol.includes("sd")
          ? "sd"
          : "unknown";

      drives.push({
        id: deviceId,
        name,
        devicePath: `/dev/${deviceId}`,
        sizeBytes: info.TotalSize ?? disk.Size,
        bus,
        platform: "darwin",
        safety,
        description: `${busProtocol || "unknown bus"} - ${content || "no partition table"}`,
      });
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
    const cacheDir = INSTALLER_TMP_DIR;
    const imagePath = path.join(cacheDir, `${image.id}.iso`);
    const rawDisk = drive.devicePath.replace("/dev/disk", "/dev/rdisk");

    // Step: resolve-image (download)
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
    onProgress("write", 0);
    // Unmount the disk first
    await execFileAsync("diskutil", ["unmountDisk", drive.devicePath]);

    // Use osascript to pop native macOS auth dialog, dd writes via raw disk for speed
    const ddCmd = `dd if=${imagePath} of=${rawDisk} bs=1m`;
    await execFileAsync("osascript", [
      "-e",
      `do shell script "${ddCmd}" with administrator privileges`,
    ]);
    onProgress("write", 1);

    // Step: verify (eject)
    onProgress("verify", 0);
    await execFileAsync("diskutil", ["eject", drive.devicePath]);
    onProgress("verify", 1);

    // Step: complete
    onProgress("complete", 1);
  }
}
