import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  IosApp,
  IosAuthState,
  IosBackend,
  IosDevice,
  IosInstallPlan,
  IosInstallRequest,
  IosInstallStepId,
  IosInstallStepStatus,
} from "./ios-types";

export class IosAuthNotReadyError extends Error {
  constructor() {
    super(
      "Apple ID authentication has not completed for this install attempt.",
    );
    this.name = "IosAuthNotReadyError";
  }
}

export class IpaWriteFailedError extends Error {
  constructor(path: string, expected: number, actual: number) {
    super(
      `IPA write verification failed: ${path} expected ${expected} bytes, got ${actual}`,
    );
    this.name = "IpaWriteFailedError";
  }
}

const ELIZAOS_APPS: IosApp[] = [
  {
    id: "elizaos-main",
    name: "elizaOS",
    version: "1.0.0-beta",
    ipaUrl: "https://download.elizaos.ai/ios/elizaos-latest.ipa",
    description: "elizaOS AI assistant for iPhone and iPad",
    minOsVersion: "16.0",
  },
];

/** Parse `key: value` lines from ideviceinfo output. */
function parseKeyValueOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function mapArchitecture(raw: string): IosDevice["architecture"] {
  const lower = raw.toLowerCase();
  if (lower.includes("arm64e")) return "arm64e";
  if (lower.includes("arm64")) return "arm64";
  if (lower.includes("armv7")) return "armv7";
  return "unknown";
}

async function runCommand(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

export class SideloaderIosBackend implements IosBackend {
  private authState: IosAuthState = { status: "idle" };

  /** Reset auth between install attempts so stale state doesn't leak across runs. */
  resetAuth(): void {
    this.authState = { status: "idle" };
  }

  async listDevices(): Promise<IosDevice[]> {
    const { stdout, exitCode } = await runCommand("ideviceid", ["-l"]);
    if (exitCode !== 0 || !stdout.trim()) return [];

    const udids = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const devices: IosDevice[] = [];
    for (const udid of udids) {
      const info = await runCommand("ideviceinfo", ["-u", udid]);
      if (info.exitCode !== 0) continue;

      const kv = parseKeyValueOutput(info.stdout);
      const connectionType: IosDevice["connectionType"] = udid.includes("-")
        ? "wifi"
        : "usb";

      devices.push({
        udid,
        name: kv.DeviceName ?? "Unknown Device",
        model: kv.ProductType ?? "Unknown",
        osVersion: kv.ProductVersion ?? "Unknown",
        architecture: mapArchitecture(kv.CPUArchitecture ?? ""),
        connectionType,
      });
    }

    return devices;
  }

  async listApps(): Promise<IosApp[]> {
    return ELIZAOS_APPS;
  }

  async getRegionNotice(): Promise<"eu-dma" | "japan-sca" | "worldwide"> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    if (tz.startsWith("Europe/")) return "eu-dma";
    if (tz === "Asia/Tokyo" || tz === "Asia/Osaka") return "japan-sca";
    return "worldwide";
  }

  async createInstallPlan(request: IosInstallRequest): Promise<IosInstallPlan> {
    // Fresh install attempt — clear any stale auth state from a previous run.
    this.resetAuth();

    const devices = await this.listDevices();
    const device = devices.find((d) => d.udid === request.deviceUdid);
    if (!device) throw new Error(`Device not found: ${request.deviceUdid}`);

    const apps = await this.listApps();
    const app = apps.find((a) => a.id === request.appId);
    if (!app) throw new Error(`App not found: ${request.appId}`);

    const regionNotice = await this.getRegionNotice();

    return {
      device,
      app,
      regionNotice,
      requiresAppleId: true,
      steps: [
        { id: "detect-device", label: "Detect device", status: "pending" },
        {
          id: "authenticate",
          label: "Sign in with Apple ID",
          status: "pending",
        },
        {
          id: "verify-2fa",
          label: "Two-factor authentication",
          status: "pending",
        },
        { id: "download-ipa", label: "Download app", status: "pending" },
        { id: "sign-ipa", label: "Sign app", status: "pending" },
        { id: "install-ipa", label: "Install on device", status: "pending" },
        { id: "complete", label: "Complete", status: "pending" },
      ],
    };
  }

  async authenticate(appleId: string, password: string): Promise<IosAuthState> {
    this.authState = { status: "authenticating", appleId };

    const { stdout, stderr, exitCode } = await runCommand(
      "sideloader",
      ["auth", "login", "--apple-id", appleId],
      // Pass password via env var — never logged or shown
      { SIDELOADER_PASSWORD: password },
    );

    const combined = (stdout + stderr).toLowerCase();

    if (exitCode === 0 && combined.includes("success")) {
      this.authState = { status: "authenticated", appleId };
      return this.authState;
    }

    if (
      combined.includes("2fa") ||
      combined.includes("two-factor") ||
      combined.includes("verification code")
    ) {
      this.authState = { status: "awaiting-2fa", appleId };
      return this.authState;
    }

    this.authState = {
      status: "failed",
      appleId,
      errorMessage: "Authentication failed. Check your Apple ID and password.",
    };
    return this.authState;
  }

  async submit2fa(code: string): Promise<IosAuthState> {
    const { stdout, stderr, exitCode } = await runCommand("sideloader", [
      "auth",
      "2fa",
      "--code",
      code,
    ]);

    const combined = (stdout + stderr).toLowerCase();

    if (
      exitCode === 0 ||
      combined.includes("success") ||
      combined.includes("authenticated")
    ) {
      this.authState = { ...this.authState, status: "authenticated" };
      return this.authState;
    }

    this.authState = {
      ...this.authState,
      status: "failed",
      errorMessage: "Invalid verification code. Please try again.",
    };
    return this.authState;
  }

  async executeInstallPlan(
    plan: IosInstallPlan,
    onProgress: (
      stepId: IosInstallStepId,
      status: IosInstallStepStatus,
      detail?: string,
    ) => void,
  ): Promise<void> {
    const { udid } = plan.device;
    let tmpDir: string | null = null;

    try {
      // Step: detect-device
      onProgress("detect-device", "running");
      const { stdout: deviceList, exitCode: detectExit } = await runCommand(
        "ideviceid",
        ["-l"],
      );
      if (detectExit !== 0 || !deviceList.includes(udid)) {
        onProgress(
          "detect-device",
          "failed",
          "Device not found. Ensure it is connected and trusted.",
        );
        return;
      }
      onProgress("detect-device", "complete");

      // Authentication MUST have completed before reaching the executor.
      // The UI calls /ios/authenticate (and /ios/2fa if needed) before /ios/execute.
      if (this.authState.status !== "authenticated") {
        onProgress(
          "authenticate",
          "failed",
          "Apple ID authentication did not complete before install.",
        );
        throw new IosAuthNotReadyError();
      }
      onProgress("authenticate", "complete");

      // Step: verify-2fa — handled externally via UI; if we reach here auth is done
      onProgress("verify-2fa", "complete");

      // Step: download-ipa
      onProgress("download-ipa", "running", "Downloading IPA…");
      tmpDir = await mkdtemp(join(tmpdir(), "elizaos-ios-"));
      const ipaPath = join(tmpDir, "app.ipa");

      const ipaResponse = await fetch(plan.app.ipaUrl);
      if (!ipaResponse.ok) {
        onProgress(
          "download-ipa",
          "failed",
          `Download failed: HTTP ${ipaResponse.status}`,
        );
        return;
      }

      const ipaBuffer = await ipaResponse.arrayBuffer();
      await Bun.write(ipaPath, ipaBuffer);

      // Verify the file was actually written with the expected byte count.
      const writtenStat = await stat(ipaPath).catch(() => null);
      if (!writtenStat || writtenStat.size !== ipaBuffer.byteLength) {
        const actual = writtenStat ? writtenStat.size : 0;
        throw new IpaWriteFailedError(ipaPath, ipaBuffer.byteLength, actual);
      }

      onProgress(
        "download-ipa",
        "complete",
        `Downloaded ${(ipaBuffer.byteLength / 1_048_576).toFixed(1)} MB`,
      );

      // Step: sign-ipa
      onProgress("sign-ipa", "running", "Signing with Apple ID certificate…");
      const signedPath = join(tmpDir, "app-signed.ipa");
      const signResult = await runCommand("sideloader", [
        "sign",
        "--ipa",
        ipaPath,
        "--output",
        signedPath,
      ]);
      if (signResult.exitCode !== 0) {
        onProgress(
          "sign-ipa",
          "failed",
          signResult.stderr.trim() || "Signing failed",
        );
        return;
      }
      onProgress("sign-ipa", "complete");

      // Step: install-ipa
      onProgress("install-ipa", "running", "Installing on device…");
      const installResult = await runCommand("sideloader", [
        "install",
        "--ipa",
        signedPath,
        "--device",
        udid,
      ]);
      if (installResult.exitCode !== 0) {
        onProgress(
          "install-ipa",
          "failed",
          installResult.stderr.trim() || "Install failed",
        );
        return;
      }
      onProgress("install-ipa", "complete");

      // Step: complete
      onProgress("complete", "complete");
    } catch (err) {
      // Surface unexpected errors without hiding them
      onProgress("install-ipa", "failed", String(err));
      throw err;
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
      // Auth is per-attempt — never carry it into the next install.
      this.resetAuth();
    }
  }
}
