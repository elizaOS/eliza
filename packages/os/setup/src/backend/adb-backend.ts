// Implements backend device and HTTP operations for the AOSP setup flasher.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import hardwareInventory from "../../../android/hardware-targets.json";
import type {
  AndroidReleaseManifest,
  AospBuild,
  AospFlasherBackend,
  ConnectedDevice,
  DeviceSpecs,
  FlashPlan,
  FlashRequest,
  FlashStep,
  FlashStepId,
  FlashStepStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Supported elizaOS device codenames
// ---------------------------------------------------------------------------

interface HardwareTarget {
  targetId: string;
  codenames: string[];
  sourceStatus: "pinned" | "pinned-generated" | "blocked";
  installerEligible: boolean;
  productName?: string;
  expectedFingerprintPrefix?: string;
}

export function parseHardwareTargets(value: unknown): HardwareTarget[] {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    throw new Error("Android hardware inventory is invalid.");
  }
  const targetIds = new Set<string>();
  const codenames = new Set<string>();
  const targets: HardwareTarget[] = [];
  for (const candidate of value.targets) {
    if (
      !isRecord(candidate) ||
      typeof candidate.targetId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(candidate.targetId) ||
      targetIds.has(candidate.targetId) ||
      !Array.isArray(candidate.codenames) ||
      candidate.codenames.length === 0 ||
      new Set(candidate.codenames).size !== candidate.codenames.length ||
      candidate.codenames.some(
        (codename) =>
          typeof codename !== "string" ||
          !/^[A-Za-z0-9._-]+$/.test(codename) ||
          codenames.has(codename),
      ) ||
      !["pinned", "pinned-generated", "blocked"].includes(
        String(candidate.sourceStatus),
      ) ||
      typeof candidate.installerEligible !== "boolean" ||
      (candidate.installerEligible &&
        !["pinned", "pinned-generated"].includes(
          String(candidate.sourceStatus),
        )) ||
      (["pinned", "pinned-generated"].includes(
        String(candidate.sourceStatus),
      ) &&
        (typeof candidate.productName !== "string" ||
          !/^[A-Za-z0-9._-]+$/.test(candidate.productName) ||
          typeof candidate.expectedFingerprintPrefix !== "string" ||
          !candidate.expectedFingerprintPrefix.endsWith(":")))
    ) {
      throw new Error("Android hardware inventory contains an invalid target.");
    }
    targetIds.add(candidate.targetId);
    for (const codename of candidate.codenames as string[]) {
      codenames.add(codename);
    }
    targets.push(candidate as unknown as HardwareTarget);
  }
  return targets;
}

const HARDWARE_TARGETS = parseHardwareTargets(hardwareInventory);
const HARDWARE_TARGETS_BY_ID = new Map(
  HARDWARE_TARGETS.map((target) => [target.targetId, target]),
);
const REQUIRED_VALIDATION_TOKENS = [
  "pm path",
  "cmd role holders",
  "foreground",
  "service",
  "/api/health",
  "logcat",
  "selinux",
] as const;

function eligibleTargetForCodename(
  codename: string,
): HardwareTarget | undefined {
  return HARDWARE_TARGETS.find(
    (target) => target.installerEligible && target.codenames.includes(codename),
  );
}

// ---------------------------------------------------------------------------
// Workspace paths — never hardcode /tmp; use os.tmpdir()
// ---------------------------------------------------------------------------

const ARTIFACT_TMP_ROOT = join(tmpdir(), "elizaos-setup");

function artifactDirFor(buildId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(buildId)) {
    throw new Error(`Invalid Android release id: ${buildId}`);
  }
  return join(ARTIFACT_TMP_ROOT, buildId);
}

function canonicalInstallerPath(): string | undefined {
  const candidates = [
    fileURLToPath(
      new URL(
        "../../../android/installer/install-elizaos-android.sh",
        import.meta.url,
      ),
    ),
    fileURLToPath(
      new URL(
        "../android-installer/install-elizaos-android.sh",
        import.meta.url,
      ),
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateDiscoveredManifest(
  value: unknown,
): AndroidReleaseManifest {
  if (!isRecord(value)) throw new Error("Android manifest must be an object.");
  if (value.schemaVersion !== 1) {
    throw new Error("Android manifest schemaVersion must be 1.");
  }
  if (
    typeof value.releaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(value.releaseId)
  ) {
    throw new Error("Android manifest releaseId is invalid.");
  }
  if (
    typeof value.generatedAt !== "string" ||
    Number.isNaN(Date.parse(value.generatedAt))
  ) {
    throw new Error("Android manifest generatedAt is invalid.");
  }
  if (
    typeof value.buildFingerprint !== "string" ||
    value.buildFingerprint.length === 0
  ) {
    throw new Error("Android manifest buildFingerprint is invalid.");
  }
  if (
    !Array.isArray(value.supportedDevices) ||
    !value.supportedDevices.length
  ) {
    throw new Error("Android manifest has no supported devices.");
  }
  for (const device of value.supportedDevices) {
    if (
      !isRecord(device) ||
      typeof device.targetId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.targetId) ||
      typeof device.codename !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(device.codename) ||
      !["lab-validated", "candidate", "manual", "blocked"].includes(
        String(device.tier),
      ) ||
      !Array.isArray(device.slots) ||
      !device.slots.length ||
      device.slots.some((slot) => !["a", "b", "none"].includes(String(slot))) ||
      typeof device.dynamicPartitions !== "boolean" ||
      typeof device.rollbackSupported !== "boolean"
    ) {
      throw new Error("Android manifest contains an invalid supported device.");
    }
    const inventoryTarget = HARDWARE_TARGETS_BY_ID.get(device.targetId);
    if (!inventoryTarget?.codenames.includes(device.codename)) {
      throw new Error(
        "Android manifest device does not match the repository hardware inventory.",
      );
    }
    if (device.tier === "lab-validated" && !inventoryTarget.installerEligible) {
      throw new Error(
        "Android manifest cannot promote an installer-ineligible hardware target.",
      );
    }
    if (
      inventoryTarget.expectedFingerprintPrefix &&
      !value.buildFingerprint.startsWith(
        inventoryTarget.expectedFingerprintPrefix,
      )
    ) {
      throw new Error(
        "Android manifest fingerprint does not match the repository hardware inventory.",
      );
    }
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("Android manifest has no artifacts.");
  }
  const filenames = new Set<string>();
  const partitions = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact)) {
      throw new Error("Android manifest contains an invalid artifact.");
    }
    const partition = artifact.partition;
    const filename = artifact.filename;
    if (
      typeof partition !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(partition) ||
      typeof filename !== "string" ||
      filename !== `${partition}.img` ||
      !/^[A-Za-z0-9._-]+\.img$/.test(filename) ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      artifact.sha256 === "0".repeat(64) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      Number(artifact.sizeBytes) <= 1 ||
      typeof artifact.required !== "boolean" ||
      !["bootloader", "fastbootd"].includes(String(artifact.fastbootMode)) ||
      filenames.has(filename) ||
      partitions.has(partition)
    ) {
      throw new Error(
        "Android manifest contains an invalid artifact contract.",
      );
    }
    filenames.add(filename);
    partitions.add(partition);
  }
  if (!isRecord(value.validation) || !isRecord(value.rollback)) {
    throw new Error(
      "Android manifest validation or rollback contract is missing.",
    );
  }
  const validation = value.validation;
  const rollback = value.rollback;
  for (const device of value.supportedDevices) {
    if (!isRecord(device)) continue;
    const inventoryTarget = HARDWARE_TARGETS_BY_ID.get(String(device.targetId));
    if (
      inventoryTarget?.expectedFingerprintPrefix &&
      validation.expectedFingerprintPrefix !==
        inventoryTarget.expectedFingerprintPrefix
    ) {
      throw new Error(
        "Android manifest fingerprint does not match the repository hardware inventory.",
      );
    }
  }
  const validationTokens = Array.isArray(validation.requiredValidationTokens)
    ? validation.requiredValidationTokens
    : null;
  if (
    !Number.isSafeInteger(validation.bootTimeoutSeconds) ||
    Number(validation.bootTimeoutSeconds) < 30 ||
    !isRecord(validation.properties) ||
    validationTokens === null ||
    new Set(validationTokens).size !== validationTokens.length ||
    !REQUIRED_VALIDATION_TOKENS.every((token) =>
      validationTokens.includes(token),
    ) ||
    typeof rollback.previousReleaseId !== "string" ||
    rollback.previousReleaseId.length === 0 ||
    typeof rollback.notes !== "string" ||
    rollback.notes.length === 0
  ) {
    throw new Error(
      "Android manifest runtime validation or rollback evidence is incomplete.",
    );
  }
  return value as unknown as AndroidReleaseManifest;
}

// ---------------------------------------------------------------------------
// ADB/fastboot tool discovery
// ---------------------------------------------------------------------------

function findAdb(): string {
  const candidates: string[] = [
    process.env.ANDROID_HOME
      ? join(process.env.ANDROID_HOME, "platform-tools", "adb")
      : "",
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "adb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "adb") return "adb";
    if (existsSync(candidate)) return candidate;
  }
  return "adb";
}

function findFastboot(): string {
  const candidates: string[] = [
    process.env.ANDROID_HOME
      ? join(process.env.ANDROID_HOME, "platform-tools", "fastboot")
      : "",
    "/opt/homebrew/bin/fastboot",
    "/usr/local/bin/fastboot",
    "fastboot",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === "fastboot") return "fastboot";
    if (existsSync(candidate)) return candidate;
  }
  return "fastboot";
}

// ---------------------------------------------------------------------------
// Subprocess helper
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(
  cmd: string,
  args: readonly string[],
  timeoutMs = 10_000,
): RunResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ADB device listing
// ---------------------------------------------------------------------------

interface RawAdbDevice {
  serial: string;
  state: string;
  model: string | undefined;
}

function parseAdbDevices(output: string): RawAdbDevice[] {
  const lines = output.split("\n");
  const devices: RawAdbDevice[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices")) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) continue;

    const serial = tokens[0];
    const state = tokens[1];
    if (!serial || !state) continue;

    let model: string | undefined;
    for (const token of tokens.slice(2)) {
      if (token.startsWith("model:")) {
        model = token.slice("model:".length).replace(/_/g, " ");
        break;
      }
    }

    devices.push({ serial, state, model });
  }

  return devices;
}

// ---------------------------------------------------------------------------
// Artifact download with SHA-256 verification
// ---------------------------------------------------------------------------

export async function downloadAndVerifyArtifacts(
  manifest: AndroidReleaseManifest,
  artifactUrls: Readonly<Record<string, string>>,
  destDir: string,
  onProgress: (fraction: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  await mkdir(destDir, { recursive: true });

  const totalBytes = manifest.artifacts.reduce(
    (sum, a) => sum + a.sizeBytes,
    0,
  );
  let bytesWritten = 0;
  const paths: Record<string, string> = {};

  for (const artifact of manifest.artifacts) {
    const url = artifactUrls[artifact.filename];
    if (!url?.startsWith("https://github.com/")) {
      throw new Error(
        `Missing trusted GitHub release asset URL for ${artifact.filename}`,
      );
    }
    const finalPath = join(destDir, artifact.filename);
    const partialPath = `${finalPath}.partial`;

    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to download ${artifact.filename}: HTTP ${response.status}`,
      );
    }

    const hash = createHash("sha256");
    const writeStream = createWriteStream(partialPath);
    let artifactBytes = 0;

    const bodyStream = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );

    bodyStream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      artifactBytes += chunk.byteLength;
      bytesWritten += chunk.byteLength;
      if (totalBytes > 0) {
        onProgress(Math.min(bytesWritten / totalBytes, 1));
      }
    });

    try {
      await pipeline(bodyStream, writeStream);
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    }

    const digest = hash.digest("hex");
    if (artifactBytes !== artifact.sizeBytes || digest !== artifact.sha256) {
      await rm(partialPath, { force: true });
      throw new Error(
        `Integrity mismatch for ${artifact.filename}: expected ${artifact.sizeBytes} bytes / ${artifact.sha256}, got ${artifactBytes} bytes / ${digest}`,
      );
    }

    await rename(partialPath, finalPath);
    paths[artifact.filename] = finalPath;
  }

  return paths;
}

// ---------------------------------------------------------------------------
// AdbFlasherBackend
// ---------------------------------------------------------------------------

export class AdbFlasherBackend implements AospFlasherBackend {
  private readonly adb: string;
  private readonly fastboot: string;

  constructor() {
    this.adb = findAdb();
    this.fastboot = findFastboot();
  }

  async listConnectedDevices(): Promise<ConnectedDevice[]> {
    const { stdout } = run(this.adb, ["devices", "-l"]);
    const raw = parseAdbDevices(stdout);
    const connected: ConnectedDevice[] = [];

    for (const raw_ of raw) {
      if (!raw_.serial) continue;

      const state = this.normalizeAdbState(raw_.state);

      let model = raw_.model ?? "Unknown";
      let codename = "unknown";
      let bootloaderUnlocked: boolean | null = null;

      if (state === "device") {
        const modelResult = run(this.adb, [
          "-s",
          raw_.serial,
          "shell",
          "getprop",
          "ro.product.model",
        ]);
        if (modelResult.status === 0) {
          const parsed = modelResult.stdout.trim();
          if (parsed) model = parsed;
        }

        const codenameResult = run(this.adb, [
          "-s",
          raw_.serial,
          "shell",
          "getprop",
          "ro.product.device",
        ]);
        if (codenameResult.status === 0) {
          const parsed = codenameResult.stdout.trim();
          if (parsed) codename = parsed;
        }
      } else if (state === "bootloader") {
        const productResult = run(this.fastboot, [
          "-s",
          raw_.serial,
          "getvar",
          "product",
        ]);
        const productOutput = productResult.stdout + productResult.stderr;
        const product = productOutput.match(
          /(?:^|\n)product:\s*([^\s]+)/i,
        )?.[1];
        if (product) codename = product;
        const unlockResult = run(this.fastboot, [
          "-s",
          raw_.serial,
          "getvar",
          "unlocked",
        ]);
        const output = (
          unlockResult.stdout + unlockResult.stderr
        ).toLowerCase();
        if (output.includes("unlocked: yes")) bootloaderUnlocked = true;
        else if (output.includes("unlocked: no")) bootloaderUnlocked = false;
      }

      connected.push({
        serial: raw_.serial,
        model,
        codename,
        state,
        bootloaderUnlocked,
      });
    }

    return connected;
  }

  private normalizeAdbState(raw: string): ConnectedDevice["state"] {
    switch (raw) {
      case "device":
        return "device";
      case "bootloader":
        return "bootloader";
      case "recovery":
        return "recovery";
      case "unauthorized":
        return "unauthorized";
      default:
        return "offline";
    }
  }

  async getDeviceSpecs(serial: string): Promise<DeviceSpecs> {
    const getprop = (prop: string): string => {
      const r = run(this.adb, ["-s", serial, "shell", "getprop", prop]);
      return r.status === 0 ? r.stdout.trim() : "";
    };

    const androidVersion = getprop("ro.build.version.release");
    const abi = getprop("ro.product.cpu.abi");
    const codename = getprop("ro.product.device");

    const flashLocked = getprop("ro.boot.flash.locked");
    let bootloaderLocked: boolean | null = null;
    if (flashLocked === "1") bootloaderLocked = true;
    else if (flashLocked === "0") bootloaderLocked = false;

    let storageAvailableBytes = 0;
    let storageTotalBytes = 0;
    const dfResult = run(this.adb, ["-s", serial, "shell", "df", "/data"]);
    if (dfResult.status === 0) {
      const lines = dfResult.stdout.trim().split("\n");
      const dataLine = lines.find((l) => l.includes("/data"));
      if (dataLine) {
        const cols = dataLine.trim().split(/\s+/);
        const blocks1k = parseInt(cols[1] ?? "0", 10);
        const available1k = parseInt(cols[3] ?? "0", 10);
        if (!Number.isNaN(blocks1k)) storageTotalBytes = blocks1k * 1024;
        if (!Number.isNaN(available1k))
          storageAvailableBytes = available1k * 1024;
      }
    }

    const supportedByElizaOs =
      codename !== "" && eligibleTargetForCodename(codename) !== undefined;

    return {
      storageAvailableBytes,
      storageTotalBytes,
      androidVersion,
      abi,
      bootloaderLocked,
      supportedByElizaOs,
      supportedBuildCodename: supportedByElizaOs ? codename : null,
    };
  }

  async listBuilds(): Promise<AospBuild[]> {
    const response = await fetch(
      "https://api.github.com/repos/elizaOS/os/releases",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Android release discovery failed: GitHub returned HTTP ${response.status}`,
      );
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error("Android release discovery returned malformed JSON.");
    }
    const releases = payload as Array<{
      assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
      prerelease?: unknown;
      tag_name?: unknown;
    }>;

    const builds: AospBuild[] = [];

    for (const release of releases) {
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const releaseAssetUrls = new Map<string, string>();
      for (const asset of assets) {
        if (
          typeof asset.name === "string" &&
          typeof asset.browser_download_url === "string" &&
          asset.browser_download_url.startsWith("https://github.com/")
        ) {
          releaseAssetUrls.set(asset.name, asset.browser_download_url);
        }
      }

      for (const asset of assets) {
        if (
          typeof asset.name !== "string" ||
          typeof asset.browser_download_url !== "string" ||
          !/^android-release-manifest-.+\.json$/.test(asset.name)
        ) {
          continue;
        }

        const manifestResp = await fetch(asset.browser_download_url, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!manifestResp.ok) continue;

        const manifest = validateDiscoveredManifest(await manifestResp.json());
        const supportedDevice = manifest.supportedDevices.find(
          (device) =>
            device.tier === "lab-validated" &&
            HARDWARE_TARGETS_BY_ID.get(device.targetId)?.installerEligible ===
              true,
        );
        if (!supportedDevice) continue;

        const artifactUrls: Record<string, string> = {};
        let missingAsset = false;
        for (const artifact of manifest.artifacts) {
          const url = releaseAssetUrls.get(artifact.filename);
          if (!url) {
            missingAsset = true;
            break;
          }
          artifactUrls[artifact.filename] = url;
        }
        if (missingAsset) continue;

        const totalSize = manifest.artifacts.reduce(
          (sum, artifact) => sum + artifact.sizeBytes,
          0,
        );

        builds.push({
          id: manifest.releaseId,
          label: supportedDevice.marketingName
            ? `elizaOS for ${supportedDevice.marketingName}`
            : "elizaOS Android",
          version: manifest.releaseId,
          channel:
            release.prerelease === true
              ? typeof release.tag_name === "string" &&
                release.tag_name.toLowerCase().includes("nightly")
                ? "nightly"
                : "beta"
              : "stable",
          targetDevice: supportedDevice.codename,
          targetId: supportedDevice.targetId,
          architecture: "arm64-v8a",
          publishedAt: manifest.generatedAt,
          manifestUrl: asset.browser_download_url,
          sizeBytes: totalSize,
          manifest,
          artifactUrls,
        });
      }
    }

    if (builds.length === 0) {
      throw new Error(
        "No published elizaOS Android release manifests are available.",
      );
    }
    if (new Set(builds.map((build) => build.id)).size !== builds.length) {
      throw new Error("Published Android release ids are not unique.");
    }
    return builds;
  }

  async createFlashPlan(request: FlashRequest): Promise<FlashPlan> {
    const [devices, builds] = await Promise.all([
      this.listConnectedDevices(),
      this.listBuilds(),
    ]);

    const device = devices.find((d) => d.serial === request.deviceSerial);
    if (!device) {
      throw new Error(`Device not found: ${request.deviceSerial}`);
    }

    const baseBuild = builds.find((b) => b.id === request.buildId);
    if (!baseBuild) {
      throw new Error(`Build not found: ${request.buildId}`);
    }

    // Carry wipeData through on the build so the flash step preview reflects it.
    const build: AospBuild = { ...baseBuild, wipeData: request.wipeData };
    const inventoryTarget = HARDWARE_TARGETS_BY_ID.get(build.targetId);
    if (
      !inventoryTarget?.installerEligible ||
      !inventoryTarget.codenames.includes(device.codename) ||
      build.targetDevice !== device.codename
    ) {
      throw new Error(
        `Build ${build.id} is not authorized for connected device ${device.codename}.`,
      );
    }

    const artifactDir = build.artifactDir ?? null;
    const serial = request.deviceSerial;
    const downloadDest = artifactDirFor(build.id);

    const steps: FlashStep[] = [
      {
        id: "detect-device",
        label: "Detect device",
        status: "pending",
        detail: `adb -s ${serial} get-state`,
      },
      {
        id: "check-bootloader",
        label: "Check bootloader lock state",
        status: "pending",
        detail: `fastboot -s ${serial} getvar unlocked`,
      },
      {
        id: "reboot-bootloader",
        label: "Reboot to bootloader",
        status: "pending",
        detail: `adb -s ${serial} reboot bootloader`,
      },
      {
        id: "unlock-bootloader",
        label: "Unlock bootloader",
        status: "pending",
        detail: `fastboot -s ${serial} flashing unlock`,
        userAction:
          "On your device, use volume keys to select UNLOCK THE BOOTLOADER and press the power button",
      },
      {
        id: "download-artifacts",
        label: "Download build artifacts",
        status: "pending",
        detail: artifactDir
          ? `Using local artifacts at ${artifactDir}`
          : `Downloading ${build.label} (${formatBytes(build.sizeBytes)}) to ${downloadDest}/`,
      },
      {
        id: "verify-artifacts",
        label: "Verify artifacts",
        status: "pending",
        detail: "Checking boot.img, vendor_boot.img, super.img, vbmeta.img",
      },
      {
        id: "flash-partitions",
        label: "Flash partitions",
        status: "pending",
        detail: request.wipeData
          ? `install-elizaos-android.sh --device ${serial} --execute --confirm-flash --wipe-data`
          : `install-elizaos-android.sh --device ${serial} --execute --confirm-flash`,
      },
      {
        id: "reboot-android",
        label: "Reboot to Android",
        status: "pending",
        detail: `fastboot -s ${serial} reboot`,
      },
      {
        id: "validate-boot",
        label: "Validate boot",
        status: "pending",
        detail: `adb -s ${serial} wait-for-device && adb -s ${serial} shell getprop sys.boot_completed`,
      },
      {
        id: "complete",
        label: "Complete",
        status: "pending",
        detail: "elizaOS flashed successfully",
      },
    ];

    return {
      device,
      build,
      steps,
      artifactDir,
      request,
    };
  }

  async executeFlashPlan(
    plan: FlashPlan,
    onProgress: (
      stepId: FlashStepId,
      status: FlashStepStatus,
      detail: string,
    ) => void,
  ): Promise<void> {
    const { device, build } = plan;
    const serial = device.serial;
    const dryRun = plan.request.dryRun === true;
    const stopAfter = plan.request.stopAfter;

    if (plan.steps[0]?.id !== "detect-device") {
      throw new Error("Unexpected plan shape — steps out of order");
    }

    // Dry-run: log every command without executing.
    if (dryRun) {
      for (const step of plan.steps) {
        onProgress(step.id, "complete", `DRY RUN: would run: ${step.detail}`);
        if (stopAfter && step.id === stopAfter) return;
      }
      return;
    }

    const shouldStop = (stepId: FlashStepId): boolean =>
      stopAfter !== undefined && stepId === stopAfter;

    // 1. detect-device
    onProgress("detect-device", "running", `adb -s ${serial} get-state`);
    const stateResult = run(this.adb, ["-s", serial, "get-state"]);
    if (stateResult.status !== 0) {
      onProgress(
        "detect-device",
        "failed",
        `Device not responding: ${stateResult.stderr.trim()}`,
      );
      throw new Error(`Device ${serial} is not connected`);
    }
    onProgress("detect-device", "complete", stateResult.stdout.trim());
    if (shouldStop("detect-device")) return;

    // 2. check-bootloader
    onProgress(
      "check-bootloader",
      "running",
      "Checking if bootloader is already unlocked",
    );
    const lockedProp = run(this.adb, [
      "-s",
      serial,
      "shell",
      "getprop",
      "ro.boot.flash.locked",
    ]);
    let alreadyUnlocked = lockedProp.stdout.trim() === "0";
    onProgress(
      "check-bootloader",
      "complete",
      alreadyUnlocked
        ? "Bootloader is unlocked"
        : "Bootloader is locked — will need unlock",
    );
    if (shouldStop("check-bootloader")) return;

    // 3. reboot-bootloader
    onProgress(
      "reboot-bootloader",
      "running",
      `adb -s ${serial} reboot bootloader`,
    );
    const rebootResult = run(
      this.adb,
      ["-s", serial, "reboot", "bootloader"],
      15_000,
    );
    if (rebootResult.status !== 0) {
      onProgress(
        "reboot-bootloader",
        "failed",
        `Failed to reboot: ${rebootResult.stderr.trim()}`,
      );
      throw new Error("Failed to reboot to bootloader");
    }

    let inFastboot = false;
    for (let i = 0; i < 30; i++) {
      await sleep(2_000);
      const fbDevices = run(this.fastboot, ["devices"]);
      if (fbDevices.stdout.includes(serial)) {
        inFastboot = true;
        break;
      }
    }
    if (!inFastboot) {
      onProgress(
        "reboot-bootloader",
        "failed",
        "Timed out waiting for fastboot",
      );
      throw new Error("Device did not enter fastboot within 60 seconds");
    }
    onProgress("reboot-bootloader", "complete", "Device in fastboot mode");
    if (shouldStop("reboot-bootloader")) return;

    const unlockVar = run(this.fastboot, ["-s", serial, "getvar", "unlocked"]);
    const unlockOutput = (unlockVar.stdout + unlockVar.stderr).toLowerCase();
    alreadyUnlocked = unlockOutput.includes("unlocked: yes");

    // 4. unlock-bootloader
    if (alreadyUnlocked) {
      onProgress(
        "unlock-bootloader",
        "complete",
        "Bootloader already unlocked — skipping",
      );
    } else {
      onProgress("unlock-bootloader", "waiting-user", "Initiating unlock...");
      // The unlock command itself may return non-zero before the user confirms.
      // Don't fail on its exit code — poll for the unlocked state instead.
      run(this.fastboot, ["-s", serial, "flashing", "unlock"]);

      let confirmed = false;
      for (let i = 0; i < 24; i++) {
        await sleep(5_000);
        const check = run(this.fastboot, ["-s", serial, "getvar", "unlocked"]);
        const out = (check.stdout + check.stderr).toLowerCase();
        if (out.includes("unlocked: yes")) {
          confirmed = true;
          break;
        }
      }
      if (!confirmed) {
        onProgress(
          "unlock-bootloader",
          "failed",
          "Bootloader unlock not confirmed within 120 seconds",
        );
        throw new Error("Bootloader unlock timed out");
      }
      onProgress("unlock-bootloader", "complete", "Bootloader unlocked");
    }
    if (shouldStop("unlock-bootloader")) return;

    // 5. download-artifacts
    let artifactDir = plan.artifactDir;
    let artifactPaths: Record<string, string> = plan.artifactPaths ?? {};
    let manifestPath = build.manifestPath;
    let manifest = build.manifest;
    if (!artifactDir) {
      const dest = artifactDirFor(build.id);
      await mkdir(dest, { recursive: true });

      onProgress(
        "download-artifacts",
        "running",
        `Downloading manifest from ${build.manifestUrl}`,
      );

      if (!manifest || !build.artifactUrls) {
        throw new Error(
          "Build is missing its validated release manifest or GitHub asset map.",
        );
      }

      try {
        artifactPaths = await downloadAndVerifyArtifacts(
          manifest,
          build.artifactUrls,
          dest,
          (fraction) => {
            onProgress(
              "download-artifacts",
              "running",
              `Downloading artifacts: ${Math.round(fraction * 100)}%`,
            );
          },
        );
      } catch (err) {
        onProgress(
          "download-artifacts",
          "failed",
          err instanceof Error ? err.message : String(err),
        );
        throw err;
      }

      artifactDir = dest;
      manifestPath = join(dest, "android-release-manifest.json");
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      plan.artifactPaths = artifactPaths;
      onProgress(
        "download-artifacts",
        "complete",
        `${manifest.artifacts.length} artifacts downloaded to ${dest}`,
      );
    } else {
      if (!manifestPath || !existsSync(manifestPath)) {
        throw new Error(
          "Local Android artifacts require a validated release manifest path.",
        );
      }
      manifest = validateDiscoveredManifest(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      onProgress(
        "download-artifacts",
        "complete",
        `Using local artifacts at ${artifactDir}`,
      );
    }

    if (!manifestPath) {
      throw new Error("Android release manifest path is unavailable.");
    }

    // 6. verify-artifacts
    onProgress("verify-artifacts", "running", "Checking artifact files...");
    const requiredImages = (manifest?.artifacts ?? [])
      .filter((artifact) => artifact.required)
      .map((artifact) => artifact.filename);
    if (requiredImages.length === 0) {
      throw new Error("Android release manifest has no required artifacts.");
    }
    const missing: string[] = [];
    for (const img of requiredImages) {
      const path = artifactPaths[img] ?? join(artifactDir, img);
      if (!existsSync(path)) {
        missing.push(img);
      }
    }
    if (missing.length > 0) {
      onProgress(
        "verify-artifacts",
        "failed",
        `Missing required images: ${missing.join(", ")}`,
      );
      throw new Error(`Missing artifact files: ${missing.join(", ")}`);
    }
    onProgress("verify-artifacts", "complete", "All required images present");

    // 7. flash-partitions
    onProgress(
      "flash-partitions",
      "running",
      "Flashing partitions via install-elizaos-android.sh...",
    );

    const scriptPath = canonicalInstallerPath();

    const flashArgs: string[] = [
      "--device",
      serial,
      "--artifact-dir",
      artifactDir,
      "--manifest",
      manifestPath,
      "--execute",
      "--confirm-flash",
      "--reboot-after-flash",
    ];
    if (build.wipeData) flashArgs.push("--wipe-data");

    if (!scriptPath) {
      throw new Error(
        "Canonical Android installer is unavailable; refusing direct flashing.",
      );
    }
    const flashResult = run("bash", [scriptPath, ...flashArgs], 600_000);

    if (flashResult.status !== 0) {
      onProgress(
        "flash-partitions",
        "failed",
        flashResult.stderr.trim() ||
          flashResult.stdout.trim() ||
          "Flash failed",
      );
      throw new Error("Flash failed");
    }
    onProgress("flash-partitions", "complete", "Partitions flashed");

    // 8. reboot-android
    onProgress("reboot-android", "running", `fastboot -s ${serial} reboot`);
    const rebootAndroid = run(this.fastboot, ["-s", serial, "reboot"], 30_000);
    if (rebootAndroid.status !== 0) {
      onProgress(
        "reboot-android",
        "failed",
        rebootAndroid.stderr.trim() ||
          `Reboot exit code ${rebootAndroid.status}`,
      );
      throw new Error("Failed to reboot device to Android");
    }
    onProgress("reboot-android", "complete", "Reboot command sent");

    // 9. validate-boot
    onProgress(
      "validate-boot",
      "running",
      "Waiting for device to boot (timeout 120s)...",
    );
    const waitResult = run(
      this.adb,
      ["-s", serial, "wait-for-device"],
      120_000,
    );
    if (waitResult.status !== 0) {
      onProgress(
        "validate-boot",
        "failed",
        "Device did not come back online within 120 seconds",
      );
      throw new Error("Device did not boot in time");
    }

    const bootProp = run(this.adb, [
      "-s",
      serial,
      "shell",
      "getprop",
      "sys.boot_completed",
    ]);
    if (bootProp.stdout.trim() !== "1") {
      onProgress(
        "validate-boot",
        "failed",
        `sys.boot_completed = ${bootProp.stdout.trim()}`,
      );
      throw new Error("Device did not fully boot");
    }
    onProgress("validate-boot", "complete", "Device booted successfully");

    // 10. complete
    onProgress("complete", "complete", "elizaOS installed successfully");
  }
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
