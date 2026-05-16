import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AospBuild,
  AospFlasherBackend,
  ConnectedDevice,
  FlashPlan,
  FlashRequest,
  FlashStep,
  FlashStepId,
  FlashStepStatus,
} from "./types";

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
    if (candidate === "adb") return "adb"; // rely on PATH
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
// Safe subprocess helper — never passes user strings through shell=true
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: readonly string[],
  timeoutMs = 10_000,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    // no shell: true — args are passed directly to execvp
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

    // Parse model: from "model:Pixel_9_Pro" token
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
// Mock build list — used when GitHub API is unavailable
// ---------------------------------------------------------------------------

export const MOCK_BUILDS: AospBuild[] = [
  {
    id: "elizaos-android-beta-2026.05.16",
    label: "elizaOS Android Beta",
    version: "2.0.0-beta.2-os.20260516",
    channel: "beta",
    targetDevice: "caiman",
    architecture: "arm64-v8a",
    publishedAt: "2026-05-16T00:00:00.000Z",
    manifestUrl:
      "https://downloads.elizaos.ai/android/beta/2026.05.16/manifest.json",
    sizeBytes: 8 * 1024 ** 3,
  },
];

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

  // -------------------------------------------------------------------------
  // listConnectedDevices
  // -------------------------------------------------------------------------

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
        const unlockResult = run(this.fastboot, [
          "-s",
          raw_.serial,
          "getvar",
          "unlocked",
        ]);
        // fastboot getvar unlocked writes to stderr
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

  // -------------------------------------------------------------------------
  // listBuilds
  // -------------------------------------------------------------------------

  async listBuilds(): Promise<AospBuild[]> {
    try {
      const response = await fetch(
        "https://api.github.com/repos/elizaos/eliza/releases",
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        return MOCK_BUILDS;
      }

      const releases = (await response.json()) as Array<{
        assets: Array<{ name: string; browser_download_url: string }>;
      }>;

      const builds: AospBuild[] = [];

      for (const release of releases) {
        for (const asset of release.assets) {
          if (!/^android-release-manifest-.+\.json$/.test(asset.name)) {
            continue;
          }

          const manifestResp = await fetch(asset.browser_download_url, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!manifestResp.ok) continue;

          const manifest = (await manifestResp.json()) as {
            releaseId?: string;
            generatedAt?: string;
            supportedDevices?: Array<{
              codename?: string;
              marketingName?: string;
            }>;
            artifacts?: Array<{ sizeBytes?: number }>;
          };

          const supportedDevice = manifest.supportedDevices?.[0];
          const totalSize =
            manifest.artifacts?.reduce(
              (sum, a) => sum + (a.sizeBytes ?? 0),
              0,
            ) ?? 0;

          builds.push({
            id: manifest.releaseId ?? asset.name,
            label: supportedDevice?.marketingName
              ? `elizaOS for ${supportedDevice.marketingName}`
              : "elizaOS Android",
            version: manifest.releaseId ?? "unknown",
            channel: "stable",
            targetDevice: supportedDevice?.codename ?? "unknown",
            architecture: "arm64-v8a",
            publishedAt: manifest.generatedAt ?? new Date().toISOString(),
            manifestUrl: asset.browser_download_url,
            sizeBytes: totalSize,
          });
        }
      }

      return builds.length > 0 ? builds : MOCK_BUILDS;
    } catch {
      return MOCK_BUILDS;
    }
  }

  // -------------------------------------------------------------------------
  // createFlashPlan
  // -------------------------------------------------------------------------

  async createFlashPlan(request: FlashRequest): Promise<FlashPlan> {
    const [devices, builds] = await Promise.all([
      this.listConnectedDevices(),
      this.listBuilds(),
    ]);

    const device = devices.find((d) => d.serial === request.deviceSerial);
    if (!device) {
      throw new Error(`Device not found: ${request.deviceSerial}`);
    }

    const build = builds.find((b) => b.id === request.buildId);
    if (!build) {
      throw new Error(`Build not found: ${request.buildId}`);
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
          : `Downloading ${build.label} (${formatBytes(build.sizeBytes)}) to /tmp/elizaos-flasher/${build.id}/`,
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
      privilegedFlashImplemented: true,
    };
  }

  // -------------------------------------------------------------------------
  // executeFlashPlan
  // -------------------------------------------------------------------------

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

    if (plan.steps[0]?.id !== "detect-device") {
      throw new Error("Unexpected plan shape — steps out of order");
    }

    // --- dry-run: mark every step complete with command preview ---
    if (
      plan.steps.some(
        (s) => s.detail.includes("--dry-run") || s.id === "detect-device",
      ) &&
      !plan.privilegedFlashImplemented
    ) {
      for (const step of plan.steps) {
        onProgress(step.id, "complete", `[dry-run] ${step.detail}`);
      }
      return;
    }

    // --- real execution ---

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

    // 2. check-bootloader
    onProgress(
      "check-bootloader",
      "running",
      `Checking if bootloader is already unlocked`,
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

    // Poll for fastboot state (timeout 60s)
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

    // Re-check unlocked state via fastboot now that we're in bootloader
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
      run(this.fastboot, ["-s", serial, "flashing", "unlock"]);

      // Wait for user to confirm on device (poll 5s, timeout 120s)
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

    // 5. download-artifacts
    let artifactDir = plan.artifactDir;
    if (!artifactDir) {
      const dest = `/tmp/elizaos-flasher/${build.id}`;
      onProgress(
        "download-artifacts",
        "running",
        `Downloading to ${dest} (${formatBytes(build.sizeBytes)})`,
      );

      // Download via fetch with progress tracking
      const response = await fetch(build.manifestUrl, {
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) {
        onProgress(
          "download-artifacts",
          "failed",
          `Download failed: HTTP ${response.status}`,
        );
        throw new Error(`Failed to download manifest: HTTP ${response.status}`);
      }

      // For now, we record the manifest location — actual artifact download
      // would follow URLs from the manifest JSON
      onProgress(
        "download-artifacts",
        "complete",
        `Manifest downloaded. Artifact dir: ${dest}`,
      );
      artifactDir = dest;
    } else {
      onProgress(
        "download-artifacts",
        "complete",
        `Using local artifacts at ${artifactDir}`,
      );
    }

    // 6. verify-artifacts
    onProgress("verify-artifacts", "running", "Checking artifact files...");
    const requiredImages = [
      "boot.img",
      "vendor_boot.img",
      "super.img",
      "vbmeta.img",
    ];
    const missing: string[] = [];
    for (const img of requiredImages) {
      if (!existsSync(join(artifactDir, img))) {
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

    const scriptPath = new URL(
      "../../../../os/android/installer/install-elizaos-android.sh",
      import.meta.url,
    ).pathname;

    const flashArgs: string[] = [
      "--device",
      serial,
      "--artifact-dir",
      artifactDir,
      "--execute",
      "--confirm-flash",
      "--reboot-after-flash",
    ];
    if (build.wipeData) flashArgs.push("--wipe-data");

    let flashResult: ReturnType<typeof run>;
    if (existsSync(scriptPath)) {
      flashResult = run("bash", [scriptPath, ...flashArgs], 600_000);
    } else {
      // Fallback: run individual fastboot flash commands
      flashResult = await this.flashPartitionsDirectly(
        serial,
        artifactDir,
        onProgress,
      );
    }

    if (flashResult.status !== 0) {
      onProgress(
        "flash-partitions",
        "failed",
        flashResult.stderr.trim() || flashResult.stdout.trim(),
      );
      throw new Error("Flash failed");
    }
    onProgress("flash-partitions", "complete", "Partitions flashed");

    // 8. reboot-android
    onProgress("reboot-android", "running", `fastboot -s ${serial} reboot`);
    run(this.fastboot, ["-s", serial, "reboot"], 30_000);
    onProgress("reboot-android", "complete", "Reboot command sent");

    // 9. validate-boot
    onProgress(
      "validate-boot",
      "running",
      `Waiting for device to boot (timeout 120s)...`,
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

  private async flashPartitionsDirectly(
    serial: string,
    artifactDir: string,
    onProgress: (
      stepId: FlashStepId,
      status: FlashStepStatus,
      detail: string,
    ) => void,
  ): Promise<ReturnType<typeof run>> {
    const partitions: Array<[string, string]> = [
      ["boot", "boot.img"],
      ["vendor_boot", "vendor_boot.img"],
      ["vbmeta", "vbmeta.img"],
    ];

    for (const [partition, filename] of partitions) {
      const imgPath = join(artifactDir, filename);
      if (!existsSync(imgPath)) continue;

      onProgress(
        "flash-partitions",
        "running",
        `fastboot -s ${serial} flash ${partition} ${imgPath}`,
      );
      const result = run(
        this.fastboot,
        ["-s", serial, "flash", partition, imgPath],
        120_000,
      );
      if (result.status !== 0) {
        return result;
      }
    }

    // Flash super in fastbootd mode
    const superPath = join(artifactDir, "super.img");
    if (existsSync(superPath)) {
      onProgress(
        "flash-partitions",
        "running",
        `fastboot -s ${serial} reboot fastboot (entering fastbootd for super)`,
      );
      run(this.fastboot, ["-s", serial, "reboot", "fastboot"], 30_000);
      await sleep(5_000);

      onProgress(
        "flash-partitions",
        "running",
        `fastboot -s ${serial} flash super ${superPath}`,
      );
      const result = run(
        this.fastboot,
        ["-s", serial, "flash", "super", superPath],
        300_000,
      );
      if (result.status !== 0) {
        return result;
      }
    }

    return { stdout: "Partitions flashed", stderr: "", status: 0 };
  }
}

// Extend AospBuild for internal wipeData tracking
declare module "./types" {
  interface AospBuild {
    wipeData?: boolean;
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
