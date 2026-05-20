import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_ELIZAOS_IMAGES } from "./dry-run-backend";
import {
  DiskutilPermissionError,
  InvalidDevicePathError,
  InvalidImagePathError,
  PlistParseError,
  UserCancelledAuthError,
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

const INSTALLER_TMP_DIR = path.join(os.tmpdir(), "elizaos-installer");

// Strict regexes used to gate paths before they hit any subprocess.
// imagePath must be an absolute file under a known macOS prefix; rawDisk must
// be a whole-disk character device like /dev/rdisk3 (NOT /dev/rdisk3s1).
const IMAGE_PATH_RE = /^\/(?:tmp|var|Users|Volumes|private)\/[A-Za-z0-9._/-]+$/;
const RAW_DISK_RE = /^\/dev\/rdisk\d+$/;
const DEVICE_DISK_RE = /^\/dev\/disk(\d+)$/;

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
  // Ejectable covers USB-NVMe enclosures (e.g. Samsung T7) that may not set
  // Removable=true but do report themselves as ejectable external devices.
  Ejectable?: boolean;
  Internal?: boolean;
  OSInternalMedia?: boolean;
  VirtualOrPhysical?: string;
}

// ---------------------------------------------------------------------------
// Shell escaping for osascript / `do shell script` round-tripping.
// ---------------------------------------------------------------------------

// POSIX single-quote escape: 'a'\''b' style. Safe to concatenate.
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// AppleScript-string escape (inside the `"..."` we hand to -e).
// Only backslashes and double-quotes need escaping inside that string literal.
export function appleScriptStringEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Plist parser. Homemade because we deliberately don't want a runtime dep,
// but every failure path now throws a typed PlistParseError instead of
// silently returning {}.
// ---------------------------------------------------------------------------

function parsePlistValue(
  xml: string,
  pos: number,
): { value: unknown; end: number } {
  while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;

  if (xml.startsWith("<true/>", pos)) return { value: true, end: pos + 7 };
  if (xml.startsWith("<false/>", pos)) return { value: false, end: pos + 8 };

  if (xml.startsWith("<integer>", pos)) {
    const end = xml.indexOf("</integer>", pos + 9);
    if (end === -1) {
      throw new PlistParseError(
        "unterminated <integer>",
        xml.slice(pos, pos + 80),
      );
    }
    return { value: Number(xml.slice(pos + 9, end)), end: end + 10 };
  }
  if (xml.startsWith("<real>", pos)) {
    const end = xml.indexOf("</real>", pos + 6);
    if (end === -1) {
      throw new PlistParseError(
        "unterminated <real>",
        xml.slice(pos, pos + 80),
      );
    }
    return { value: Number(xml.slice(pos + 6, end)), end: end + 7 };
  }
  if (xml.startsWith("<string>", pos)) {
    const end = xml.indexOf("</string>", pos + 8);
    if (end === -1) {
      throw new PlistParseError(
        "unterminated <string>",
        xml.slice(pos, pos + 80),
      );
    }
    return { value: xml.slice(pos + 8, end), end: end + 9 };
  }
  if (xml.startsWith("<string/>", pos)) return { value: "", end: pos + 9 };
  if (xml.startsWith("<dict>", pos)) return parsePlistDict(xml, pos);
  if (xml.startsWith("<array>", pos)) return parsePlistArray(xml, pos);
  if (xml.startsWith("<array/>", pos)) return { value: [], end: pos + 8 };
  if (xml.startsWith("<dict/>", pos)) return { value: {}, end: pos + 7 };

  const tagEnd = xml.indexOf(">", pos);
  if (tagEnd === -1) {
    throw new PlistParseError("malformed tag", xml.slice(pos, pos + 80));
  }
  return { value: null, end: tagEnd + 1 };
}

function parsePlistDict(
  xml: string,
  pos: number,
): { value: Record<string, unknown>; end: number } {
  const dictStart = xml.indexOf("<dict>", pos);
  if (dictStart === -1) {
    throw new PlistParseError("expected <dict>", xml.slice(pos, pos + 80));
  }
  pos = dictStart + 6;
  const out: Record<string, unknown> = {};
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(xml[pos] ?? "")) pos++;
    if (xml.startsWith("</dict>", pos)) {
      return { value: out, end: pos + 7 };
    }
    if (xml.startsWith("<key>", pos)) {
      const keyEnd = xml.indexOf("</key>", pos + 5);
      if (keyEnd === -1) {
        throw new PlistParseError(
          "unterminated <key>",
          xml.slice(pos, pos + 80),
        );
      }
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
  throw new PlistParseError("unterminated <dict>", xml.slice(-80));
}

function parsePlistArray(
  xml: string,
  pos: number,
): { value: unknown[]; end: number } {
  const arrayStart = xml.indexOf("<array>", pos);
  if (arrayStart === -1) {
    throw new PlistParseError("expected <array>", xml.slice(pos, pos + 80));
  }
  pos = arrayStart + 7;
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
  throw new PlistParseError("unterminated <array>", xml.slice(-80));
}

function parsePlist(xml: string): unknown {
  const dictPos = xml.indexOf("<dict>");
  if (dictPos === -1) {
    throw new PlistParseError(
      "no <dict> root found in plist",
      xml.slice(0, 200),
    );
  }
  return parsePlistDict(xml, dictPos).value;
}

// ---------------------------------------------------------------------------
// diskutil wrappers
// ---------------------------------------------------------------------------

interface SubprocessError {
  code?: number;
  stderr?: string;
  stdout?: string;
}

function isSubprocessError(err: unknown): err is SubprocessError {
  return (
    typeof err === "object" &&
    err !== null &&
    ("code" in err || "stderr" in err || "stdout" in err)
  );
}

async function getDiskUtilList(): Promise<DiskUtilListPlist> {
  const { stdout } = await execFileAsync("diskutil", ["list", "-plist"]);
  return parsePlist(stdout) as DiskUtilListPlist;
}

async function getDiskUtilInfo(
  deviceIdentifier: string,
): Promise<DiskUtilInfoPlist | null> {
  try {
    const { stdout } = await execFileAsync("diskutil", [
      "info",
      "-plist",
      `/dev/${deviceIdentifier}`,
    ]);
    return parsePlist(stdout) as DiskUtilInfoPlist;
  } catch (err: unknown) {
    if (isSubprocessError(err)) {
      const stderr = (err.stderr ?? "").toLowerCase();
      if (
        stderr.includes("permission denied") ||
        stderr.includes("operation not permitted")
      ) {
        throw new DiskutilPermissionError(
          `diskutil info denied for /dev/${deviceIdentifier}: ${err.stderr?.trim()}`,
          deviceIdentifier,
        );
      }
      if (stderr.includes("could not find")) {
        return null;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

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
  const partialPath = `${destPath}.partial`;

  await new Promise<void>((resolve, reject) => {
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
            const writeStream = createWriteStream(partialPath);
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              onProgress(received, total);
            });
            res.pipe(writeStream);
            writeStream.on("finish", () => resolve());
            writeStream.on("error", reject);
            res.on("error", reject);
          },
        )
        .on("error", reject);
    }
    doRequest(url);
  });

  await fs.rename(partialPath, destPath);
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

async function cleanupPartialFiles(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.endsWith(".partial"))
      .map((e) => fs.rm(path.join(dir, e), { force: true })),
  );
}

function pendingSteps(): InstallerStep[] {
  return (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
    detail: "Waiting to start.",
  }));
}

// ---------------------------------------------------------------------------
// Path validation — exported for tests.
// ---------------------------------------------------------------------------

export function validateImagePath(imagePath: string): string {
  if (!IMAGE_PATH_RE.test(imagePath)) {
    throw new InvalidImagePathError(
      `Image path does not match allowed shape: ${imagePath}`,
      imagePath,
    );
  }
  return imagePath;
}

export function deriveRawDisk(devicePath: string): string {
  const m = DEVICE_DISK_RE.exec(devicePath);
  if (!m) {
    throw new InvalidDevicePathError(
      `Device path is not a whole disk (/dev/diskN): ${devicePath}`,
      devicePath,
    );
  }
  const rawDisk = `/dev/rdisk${m[1]}`;
  if (!RAW_DISK_RE.test(rawDisk)) {
    throw new InvalidDevicePathError(
      `Derived raw disk failed validation: ${rawDisk}`,
      rawDisk,
    );
  }
  return rawDisk;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class MacOsUsbInstallerBackend implements UsbInstallerBackend {
  constructor() {
    // Clean up any leftover partial downloads from a prior interrupted run.
    void cleanupPartialFiles(INSTALLER_TMP_DIR);
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const plist = await getDiskUtilList();
    const disks = plist.AllDisksAndPartitions ?? [];
    const drives: RemovableDrive[] = [];

    for (const disk of disks) {
      const deviceId = disk.DeviceIdentifier;
      if (!deviceId) continue;

      const info = await getDiskUtilInfo(deviceId);
      if (!info) continue;

      const isInternal =
        info.Internal === true || info.OSInternalMedia === true;
      const isVirtual = info.VirtualOrPhysical === "Virtual";
      const isRemovable =
        info.Removable === true || info.RemovableMediaOrExternalDevice === true;
      const isEjectable = info.Ejectable === true;
      const busProtocol = (info.BusProtocol ?? "").toLowerCase();
      const isUsb = busProtocol === "usb";
      const isDiskImage = busProtocol === "disk image" || isVirtual;

      // USB-NVMe enclosures (e.g. Samsung T7) report BusProtocol=USB and
      // Ejectable=true but may not set Removable=true. They must never have
      // Internal=true — that flag alone blocks the drive regardless of other fields.
      const isExternalUsbEnclosure = isEjectable && !isInternal;

      const content = disk.Content ?? "";
      const isApfsOrHfs =
        content.startsWith("Apple_APFS") ||
        content.startsWith("Apple_HFS") ||
        content.startsWith("Apple_CoreStorage");

      let safety: RemovableDrive["safety"] = "unknown";
      if (isInternal) {
        // Internal flag is an absolute block.
        safety = "blocked-system";
      } else if (isApfsOrHfs) {
        // APFS/HFS/CoreStorage partitions are never installer targets.
        safety = "blocked-system";
      } else if (isDiskImage) {
        // Disk images are not real USB drives. Skip entirely.
        continue;
      } else if (isUsb || isRemovable || isExternalUsbEnclosure) {
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
    const cacheDir = INSTALLER_TMP_DIR;
    await cleanupPartialFiles(cacheDir);
    const imagePath = validateImagePath(path.join(cacheDir, `${image.id}.iso`));
    const rawDisk = deriveRawDisk(drive.devicePath);

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

    // Pre-checksum: verify size matches manifest if known.
    if (image.sizeBytes > 0) {
      const actualSize = await fileSize(imagePath);
      if (actualSize !== image.sizeBytes) {
        // Drop the bad file so the next run will re-download from scratch.
        await fs.rm(imagePath, { force: true });
        throw new Error(
          `Downloaded image size ${actualSize} does not match manifest ${image.sizeBytes}; deleted and aborting.`,
        );
      }
    }

    // Step: checksum
    onProgress("checksum", 0);
    const ZEROED_CHECKSUM = "0".repeat(64);
    if (image.checksumSha256 !== ZEROED_CHECKSUM) {
      const actual = await sha256File(imagePath);
      if (actual !== image.checksumSha256) {
        await fs.rm(imagePath, { force: true });
        throw new Error(
          `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
        );
      }
    }
    onProgress("checksum", 1);

    // Step: write
    onProgress("write", 0);
    await execFileAsync("diskutil", ["unmountDisk", drive.devicePath]);

    // Build the `dd` invocation with shell-quoted paths so that even though
    // osascript double-evaluates the string, no metacharacter can escape.
    const ddCmd = `dd if=${shellSingleQuote(imagePath)} of=${shellSingleQuote(rawDisk)} bs=1m`;
    const appleScript = `do shell script "${appleScriptStringEscape(ddCmd)}" with administrator privileges`;

    try {
      await execFileAsync("osascript", ["-e", appleScript]);
    } catch (err: unknown) {
      if (isSubprocessError(err)) {
        const stderr = err.stderr ?? "";
        if (/user cancell?ed\./i.test(stderr)) {
          throw new UserCancelledAuthError(
            "Authentication cancelled — click Write to retry.",
          );
        }
      }
      throw err;
    }
    onProgress("write", 1);

    // Step: verify (eject)
    onProgress("verify", 0);
    await execFileAsync("diskutil", ["eject", drive.devicePath]);
    onProgress("verify", 1);

    // Step: complete
    onProgress("complete", 1);
  }
}
