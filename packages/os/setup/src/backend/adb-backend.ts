import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import hardwareInventory from "../../../android/hardware-targets.json";
import { syncDirectoryTree } from "../../../scripts/android/install-lock.mjs";
import { findHostTool } from "../dependencies/host-tools";
import { executeSignedInstall, SignedInstallError } from "./signed-install";
import {
  describeSignedRelease,
  type ReleaseFile,
  signedInstallerPath,
  signedReleaseFiles,
} from "./signed-release";
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

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
  ) {
    throw new Error(
      "Artifact staging requires a private directory owned by the current user.",
    );
  }
}

async function artifactDirFor(buildId: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(buildId)) {
    throw new Error(`Invalid Android release id: ${buildId}`);
  }
  const root = join(homedir(), ".elizaos/flasher/downloads");
  await ensurePrivateDirectory(root);
  return mkdtemp(join(root, `${buildId}-`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertSupportedStop(request: FlashRequest): void {
  if (
    request.stopAfter &&
    ["flash-partitions", "reboot-android", "validate-boot"].includes(
      request.stopAfter,
    )
  ) {
    throw new SignedInstallError(
      "Signed installation cannot pause between flashing, reboot and runtime verification.",
    );
  }
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
  env = process.env,
): RunResult {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

function fastbootDevices(result: RunResult): RawAdbDevice[] {
  if (result.status !== 0)
    throw new Error(`Fastboot discovery failed: ${result.stderr.trim()}`);
  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^([A-Za-z0-9][A-Za-z0-9._:-]*)\s+fastboot\s*$/.exec(line);
      if (!match?.[1])
        throw new Error("Fastboot returned an invalid device inventory.");
      return { serial: match[1], state: "bootloader", model: undefined };
    });
}

function fastbootVariable(result: RunResult, key: string): string {
  if (result.status !== 0)
    throw new Error(`Fastboot ${key} query failed: ${result.stderr.trim()}`);
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bFAILED\b|^fastboot:\s*error:/m.test(output))
    throw new Error(`Fastboot ${key} query failed.`);
  const values = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\(bootloader\)\s*/, ""))
    .filter((line) => line.startsWith(`${key}:`))
    .map((line) => line.slice(key.length + 1).trim());
  if (values.length !== 1 || !values[0])
    throw new Error(`Fastboot ${key} state is unavailable or ambiguous.`);
  return values[0];
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
  manifest: { artifacts: readonly ReleaseFile[] },
  artifactUrls: Readonly<Record<string, string>>,
  destDir: string,
  onProgress: (fraction: number) => void,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Record<string, string>> {
  if (manifest.artifacts.length === 0)
    throw new Error("Artifact inventory is empty.");
  const names = new Set<string>();
  let totalBytes = 0;
  for (const file of manifest.artifacts) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(file.filename) ||
      names.has(file.filename) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.sha256 === "0".repeat(64) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes <= 0
    ) {
      throw new Error("Invalid or duplicate artifact file contract.");
    }
    names.add(file.filename);
    totalBytes += file.sizeBytes;
  }
  if (!Number.isSafeInteger(totalBytes))
    throw new Error("Artifact sizes exceed supported integer range.");
  await ensurePrivateDirectory(destDir);
  let bytesWritten = 0;
  const paths: Record<string, string> = {};
  for (const artifact of manifest.artifacts) {
    const url = artifactUrls[artifact.filename];
    if (!url?.startsWith("https://github.com/")) {
      throw new Error(
        `Missing trusted GitHub release asset URL for ${artifact.filename}`,
      );
    }
    const temporary = await mkdtemp(join(destDir, ".download-"));
    const partial = join(temporary, "payload");
    const finalPath = join(destDir, artifact.filename);
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `Failed to download ${artifact.filename}: HTTP ${response.status}`,
        );
      }
      const file = await open(partial, "wx", 0o600);
      const hash = createHash("sha256");
      let artifactBytes = 0;
      try {
        const body = Readable.fromWeb(
          response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
        );
        for await (const chunk of body) {
          artifactBytes += chunk.length;
          if (artifactBytes > artifact.sizeBytes)
            throw new Error(
              `Download exceeds signed size for ${artifact.filename}`,
            );
          await file.writeFile(chunk);
          hash.update(chunk);
          bytesWritten += chunk.length;
          onProgress(bytesWritten / totalBytes);
        }
        const digest = hash.digest("hex");
        if (
          artifactBytes !== artifact.sizeBytes ||
          digest !== artifact.sha256
        ) {
          throw new Error(
            `Integrity mismatch for ${artifact.filename}: expected ${artifact.sizeBytes} bytes / ${artifact.sha256}, got ${artifactBytes} bytes / ${digest}`,
          );
        }
        await file.sync();
      } finally {
        await file.close();
      }
      // A hard link publishes the verified bytes atomically without replacing
      // another attempt's file or following a pre-existing destination symlink.
      await link(partial, finalPath);
      if (process.platform === "linux") syncDirectoryTree(destDir);
      paths[artifact.filename] = finalPath;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// AdbFlasherBackend
// ---------------------------------------------------------------------------

export class AdbFlasherBackend implements AospFlasherBackend {
  constructor(
    private readonly installation: {
      healthTokenFile?: string;
      stateDirectory?: string;
    } = {},
  ) {}

  private get adb(): string {
    return findHostTool("adb") ?? "adb";
  }

  private get fastboot(): string {
    return findHostTool("fastboot") ?? "fastboot";
  }

  async listConnectedDevices(): Promise<ConnectedDevice[]> {
    const adb = run(this.adb, ["devices", "-l"]);
    if (adb.status !== 0)
      throw new Error(`ADB discovery failed: ${adb.stderr.trim()}`);
    const raw = parseAdbDevices(adb.stdout);
    for (const device of fastbootDevices(run(this.fastboot, ["devices"]))) {
      if (raw.some((other) => other.serial === device.serial))
        throw new Error(
          "Device appears on both Android transports; retry discovery.",
        );
      raw.push(device);
    }
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
        codename = fastbootVariable(productResult, "product");
        const unlocked = fastbootVariable(
          run(this.fastboot, ["-s", raw_.serial, "getvar", "unlocked"]),
          "unlocked",
        );
        if (!["yes", "no"].includes(unlocked))
          throw new Error("Fastboot returned an invalid lock state.");
        bootloaderUnlocked = unlocked === "yes";
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

        const signedManifest = await manifestResp.text();
        const description = await describeSignedRelease(signedManifest);
        const signed = description.release;
        if (
          signed.target.kind !== "physical" ||
          signed.operation !== "os-install"
        )
          continue;
        const signedFiles = signedReleaseFiles(description);
        const artifactUrls: Record<string, string> = {};
        for (const file of signedFiles) {
          const url = releaseAssetUrls.get(file.filename);
          if (!url)
            throw new Error(
              `Signed release ${signed.releaseId} is missing asset ${file.filename}`,
            );
          artifactUrls[file.filename] = url;
        }
        const totalSize = signedFiles.reduce(
          (sum, file) => sum + file.sizeBytes,
          0,
        );
        if (!Number.isSafeInteger(totalSize))
          throw new Error(
            "Signed release size exceeds supported integer range",
          );
        builds.push({
          id: signed.releaseId,
          label: `elizaOS for ${signed.target.codename}`,
          version: signed.version,
          channel: signed.channel === "canary" ? "nightly" : signed.channel,
          targetDevice: signed.target.codename,
          targetId: signed.target.id,
          architecture:
            signed.target.architecture === "arm64"
              ? "arm64-v8a"
              : signed.target.architecture,
          publishedAt: description.issuedAt,
          manifestUrl: asset.browser_download_url,
          sizeBytes: totalSize,
          signedManifest,
          signedFiles,
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
    assertSupportedStop(request);
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
          : `Downloading ${build.label} (${formatBytes(build.sizeBytes)})`,
      },
      {
        id: "verify-artifacts",
        label: "Verify artifacts",
        status: "pending",
        detail: "Checking boot.img, vendor_boot.img, super.img, vbmeta.img",
      },
      {
        id: "flash-partitions",
        label: "Install and verify signed release",
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

    if (
      request.stopAfter !== "reboot-bootloader" &&
      request.stopAfter !== "unlock-bootloader"
    ) {
      steps.splice(2, 2);
    }

    return {
      device,
      build,
      steps,
      artifactDir,
      request,
    };
  }

  private async prepareArtifacts(
    plan: FlashPlan,
    onProgress: Parameters<AospFlasherBackend["executeFlashPlan"]>[1],
  ): Promise<{
    artifactDir: string;
    manifestPath: string;
    subjectSha256: string | undefined;
  }> {
    const { build } = plan;
    let artifactDir = plan.artifactDir;
    let artifactPaths: Record<string, string> = plan.artifactPaths ?? {};
    let manifestPath = build.manifestPath;
    let manifest = build.manifest;
    let signedFiles = build.signedFiles;
    let subjectSha256: string | undefined;
    if (!artifactDir) {
      const dest = await artifactDirFor(build.id);

      onProgress(
        "download-artifacts",
        "running",
        `Downloading manifest from ${build.manifestUrl}`,
      );

      if ((!manifest && !build.signedManifest) || !build.artifactUrls) {
        throw new Error(
          "Build is missing its validated release manifest or GitHub asset map.",
        );
      }

      if (build.signedManifest) {
        const description = await describeSignedRelease(build.signedManifest);
        signedFiles = signedReleaseFiles(description);
        subjectSha256 = description.subjectSha256;
      }
      const artifacts = signedFiles ?? manifest?.artifacts;
      if (!artifacts)
        throw new Error("Android release file inventory is unavailable.");
      try {
        artifactPaths = await downloadAndVerifyArtifacts(
          { artifacts },
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
      await writeFile(
        manifestPath,
        build.signedManifest ?? `${JSON.stringify(manifest, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      plan.artifactPaths = artifactPaths;
      onProgress(
        "download-artifacts",
        "complete",
        `${artifacts.length} artifacts downloaded to ${dest}`,
      );
    } else {
      if (!manifestPath || !existsSync(manifestPath)) {
        throw new Error(
          "Local Android artifacts require a validated release manifest path.",
        );
      }
      const bytes = await readFile(manifestPath, "utf8");
      if (build.signedManifest) {
        if (bytes !== build.signedManifest)
          throw new Error("Signed manifest changed since plan review.");
        const description = await describeSignedRelease(bytes);
        signedFiles = signedReleaseFiles(description);
        subjectSha256 = description.subjectSha256;
      } else {
        manifest = validateDiscoveredManifest(JSON.parse(bytes));
      }
      onProgress(
        "download-artifacts",
        "complete",
        `Using local artifacts at ${artifactDir}`,
      );
    }

    if (!manifestPath) {
      throw new Error("Android release manifest path is unavailable.");
    }
    if (plan.request.stopAfter === "download-artifacts") {
      return { artifactDir, manifestPath, subjectSha256 };
    }

    onProgress("verify-artifacts", "running", "Checking artifact files...");
    const requiredImages = signedFiles
      ? signedFiles.map((file) => file.filename)
      : (manifest?.artifacts ?? [])
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
    const installer = signedInstallerPath();
    // Call the signed executor directly: the wrapper also accepts unsigned
    // legacy planning, which must never authorize a reboot or unlock.
    const authorization = run(
      "node",
      [
        installer,
        "--manifest",
        manifestPath,
        "--artifact-dir",
        artifactDir,
        "--dry-run",
      ],
      600_000,
    );
    if (authorization.status !== 0) {
      const detail =
        authorization.stderr.trim() ||
        authorization.stdout.trim() ||
        "Signed Android release authorization failed";
      onProgress("verify-artifacts", "failed", detail);
      throw new Error(detail);
    }
    onProgress(
      "verify-artifacts",
      "complete",
      "Signed release and artifact bytes verified",
    );
    return { artifactDir, manifestPath, subjectSha256 };
  }

  private async unlockBootloader(
    serial: string,
    onProgress: Parameters<AospFlasherBackend["executeFlashPlan"]>[1],
  ): Promise<void> {
    const unlockVar = run(this.fastboot, ["-s", serial, "getvar", "unlocked"]);
    const unlocked = fastbootVariable(unlockVar, "unlocked");
    if (!["yes", "no"].includes(unlocked))
      throw new Error("Fastboot returned an invalid lock state.");
    const alreadyUnlocked = unlocked === "yes";

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
      const deadline = performance.now() + 120_000;
      while (performance.now() < deadline) {
        await sleep(Math.min(5_000, deadline - performance.now()));
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) break;
        const check = run(
          this.fastboot,
          ["-s", serial, "getvar", "unlocked"],
          Math.min(10_000, remaining),
        );
        if (
          fastbootVariable(check, "unlocked") === "yes" &&
          performance.now() < deadline
        ) {
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
  }

  async executeFlashPlan(
    plan: FlashPlan,
    onProgress: (
      stepId: FlashStepId,
      status: FlashStepStatus,
      detail: string,
    ) => void,
  ): Promise<void> {
    assertSupportedStop(plan.request);
    const { device } = plan;
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

    if (
      device.state === "bootloader" &&
      (stopAfter === "reboot-bootloader" || stopAfter === "unlock-bootloader")
    ) {
      if (
        !fastbootDevices(run(this.fastboot, ["devices"])).some(
          (candidate) => candidate.serial === serial,
        )
      ) {
        throw new Error(
          "The selected bootloader device is no longer connected.",
        );
      }
      const product = fastbootVariable(
        run(this.fastboot, ["-s", serial, "getvar", "product"]),
        "product",
      );
      if (product !== device.codename)
        throw new Error(
          "Bootloader device identity changed since plan review.",
        );
      onProgress(
        "detect-device",
        "complete",
        "Selected bootloader device verified",
      );
      if (stopAfter === "unlock-bootloader")
        await this.unlockBootloader(serial, onProgress);
      else
        onProgress(
          "reboot-bootloader",
          "complete",
          "Device already in bootloader mode",
        );
      return;
    }

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
    const alreadyUnlocked = lockedProp.stdout.trim() === "0";
    onProgress(
      "check-bootloader",
      "complete",
      alreadyUnlocked
        ? "Bootloader is unlocked"
        : "Bootloader is locked — will need unlock",
    );
    if (shouldStop("check-bootloader")) return;

    const standaloneUnlock =
      stopAfter === "reboot-bootloader" || stopAfter === "unlock-bootloader";
    const prepared = standaloneUnlock
      ? undefined
      : await this.prepareArtifacts(plan, onProgress);
    if (shouldStop("download-artifacts") || shouldStop("verify-artifacts"))
      return;

    if (prepared) {
      if (!prepared.subjectSha256)
        throw new SignedInstallError("Signed release identity is missing.");
      if (lockedProp.status !== 0 || lockedProp.stdout.trim() !== "0") {
        throw new SignedInstallError(
          "Unlock the bootloader using the guide, then reconnect stock Android before installation.",
        );
      }
      const adb = findHostTool("adb");
      const fastboot = findHostTool("fastboot");
      if (
        !adb ||
        !fastboot ||
        dirname(resolve(adb)) !== dirname(resolve(fastboot))
      ) {
        throw new SignedInstallError(
          "Install the qualified adb and fastboot tools in the same directory.",
        );
      }
      onProgress(
        "flash-partitions",
        "running",
        "Installing the signed release and verifying the device runtime...",
      );
      try {
        const journal = await executeSignedInstall({
          ...prepared,
          subjectSha256: prepared.subjectSha256,
          serial,
          toolDir: dirname(resolve(adb)),
          healthTokenFile: this.installation.healthTokenFile ?? "",
          stateDirectory:
            this.installation.stateDirectory ??
            join(homedir(), ".elizaos/flasher/installations"),
          wipe: plan.request.wipeData,
        });
        onProgress(
          "flash-partitions",
          "complete",
          `Installation verified; journal: ${journal}`,
        );
        onProgress(
          "reboot-android",
          "complete",
          "Signed executor rebooted the installed system",
        );
        onProgress(
          "validate-boot",
          "complete",
          "Authenticated runtime and target slot verified",
        );
        onProgress(
          "complete",
          "complete",
          "elizaOS installed and runtime verified",
        );
      } catch (error) {
        onProgress(
          "flash-partitions",
          "failed",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return;
    }

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
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      await sleep(Math.min(2_000, deadline - performance.now()));
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) break;
      const fbDevices = run(
        this.fastboot,
        ["devices"],
        Math.min(10_000, remaining),
      );
      if (
        performance.now() < deadline &&
        fastbootDevices(fbDevices).some(
          (candidate) => candidate.serial === serial,
        )
      ) {
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

    await this.unlockBootloader(serial, onProgress);
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
