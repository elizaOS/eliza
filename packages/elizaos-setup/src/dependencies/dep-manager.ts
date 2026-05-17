import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Dependency,
  DependencyCheckResult,
  DependencyId,
  ManualInstallInstructions,
} from "./types";

const VENDOR_BIN_DIR = join(
  homedir(),
  ".elizaos",
  "flasher",
  "vendor",
  "bin",
  process.platform,
);

const DEPENDENCY_DEFINITIONS: Record<DependencyId, Dependency> = {
  adb: {
    id: "adb",
    name: "Android Debug Bridge (adb)",
    description: "Communicates with Android devices for detection and flashing",
    commands: ["adb"],
    requiredFor: ["android"],
  },
  fastboot: {
    id: "fastboot",
    name: "Fastboot",
    description:
      "Flashes firmware partitions on Android devices in bootloader mode",
    commands: ["fastboot"],
    requiredFor: ["android"],
  },
  libimobiledevice: {
    id: "libimobiledevice",
    name: "libimobiledevice",
    description: "Detects and communicates with iOS devices",
    commands: ["ideviceid", "ideviceinfo", "ideviceinstaller"],
    requiredFor: ["ios"],
  },
  sideloader: {
    id: "sideloader",
    name: "Sideloader",
    description: "Sideloads IPA files onto iOS devices",
    commands: ["sideloader"],
    requiredFor: ["ios"],
  },
};

function runCommand(cmd: string): { stdout: string; success: boolean } {
  try {
    const stdout = execSync(cmd, { encoding: "utf8", timeout: 15_000 }).trim();
    return { stdout, success: true };
  } catch {
    return { stdout: "", success: false };
  }
}

function whichBinary(name: string): string | undefined {
  // Check vendor bin first
  const vendorPath = join(VENDOR_BIN_DIR, name);
  if (existsSync(vendorPath)) {
    return vendorPath;
  }

  // Fall back to PATH
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  const result = runCommand(cmd);
  if (result.success && result.stdout.length > 0) {
    return result.stdout.split("\n")[0]?.trim();
  }

  return undefined;
}

function getVersion(binary: string, foundPath: string): string | undefined {
  const versionFlags: Record<string, string> = {
    adb: "--version",
    fastboot: "--version",
    ideviceid: "--version",
    ideviceinfo: "--version",
    ideviceinstaller: "--version",
    sideloader: "--version",
  };
  const flag = versionFlags[binary] ?? "--version";
  const result = runCommand(`"${foundPath}" ${flag}`);
  if (result.success && result.stdout.length > 0) {
    // First non-empty line usually contains the version
    return result.stdout.split("\n")[0]?.trim();
  }
  return undefined;
}

function checkDependency(id: DependencyId): DependencyCheckResult {
  const def = DEPENDENCY_DEFINITIONS[id];
  // For deps with multiple commands, require all of them
  const paths: string[] = [];
  for (const cmd of def.commands) {
    const found = whichBinary(cmd);
    if (!found) {
      return {
        id,
        status: "missing",
        manualInstructions: getManualInstructions(id),
      };
    }
    paths.push(found);
  }

  // All binaries found — use the first one as the representative path
  const primaryPath = paths[0];
  const primaryCommand = def.commands[0];
  if (!primaryPath || !primaryCommand) {
    return {
      id,
      status: "missing",
      manualInstructions: getManualInstructions(id),
    };
  }
  const version = getVersion(primaryCommand, primaryPath);

  const result: DependencyCheckResult = {
    id,
    status: "found",
    foundPath: primaryPath,
  };
  if (version !== undefined) {
    result.version = version;
  }
  return result;
}

function getManualInstructions(id: DependencyId): ManualInstallInstructions {
  const platform = process.platform;

  switch (id) {
    case "adb":
    case "fastboot":
      if (platform === "darwin") {
        return {
          title: "Install Android Platform Tools (macOS)",
          steps: [
            "Install Homebrew from https://brew.sh",
            "Run: brew install android-platform-tools",
            "Verify: adb version",
          ],
          url: "https://developer.android.com/tools/releases/platform-tools",
        };
      }
      if (platform === "linux") {
        return {
          title: "Install Android Platform Tools (Linux)",
          steps: [
            "Run: sudo apt update && sudo apt install android-tools-adb android-tools-fastboot",
            "Or download from: https://developer.android.com/tools/releases/platform-tools",
          ],
          url: "https://developer.android.com/tools/releases/platform-tools",
        };
      }
      return {
        title: "Install Android Platform Tools (Windows)",
        steps: [
          "Run: winget install Google.PlatformTools",
          "Or download the SDK Platform Tools zip from the link below",
          "Extract and add the folder to your PATH",
        ],
        url: "https://developer.android.com/tools/releases/platform-tools",
      };

    case "libimobiledevice":
      if (platform === "darwin") {
        return {
          title: "Install libimobiledevice (macOS)",
          steps: [
            "Install Homebrew from https://brew.sh",
            "Run: brew install libimobiledevice",
            "Verify: ideviceid --version",
          ],
          url: "https://libimobiledevice.org",
        };
      }
      if (platform === "linux") {
        return {
          title: "Install libimobiledevice (Linux)",
          steps: [
            "Run: sudo apt update && sudo apt install libimobiledevice-utils",
            "Verify: ideviceid --version",
          ],
          url: "https://libimobiledevice.org",
        };
      }
      return {
        title: "Install libimobiledevice (Windows)",
        steps: [
          "Download the prebuilt binaries from the link below",
          "Add the extracted folder to your PATH",
        ],
        url: "https://github.com/libimobiledevice-win32/imobiledevice-net/releases",
      };

    case "sideloader":
      return {
        title: "Install Sideloader",
        steps: [
          "Download from https://github.com/Dadoum/Sideloader/releases",
          "Make executable: chmod +x sideloader",
          "Move to PATH: sudo mv sideloader /usr/local/bin/",
        ],
        url: "https://github.com/Dadoum/Sideloader/releases",
      };
  }
}

async function runInstallCommand(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd.split(" "), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function downloadSideloader(): Promise<boolean> {
  const apiUrl =
    "https://api.github.com/repos/Dadoum/Sideloader/releases/latest";
  try {
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "aosp-flasher/1.0" },
    });
    if (!res.ok) return false;

    const release = (await res.json()) as {
      assets: { name: string; browser_download_url: string }[];
    };

    const platformSuffix =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : "windows";

    const asset = release.assets.find(
      (a) =>
        a.name.toLowerCase().includes(platformSuffix) &&
        !a.name.endsWith(".sha256"),
    );
    if (!asset) return false;

    const binRes = await fetch(asset.browser_download_url);
    if (!binRes.ok) return false;

    const destDir = VENDOR_BIN_DIR;
    const destPath = join(destDir, "sideloader");

    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    await mkdir(destDir, { recursive: true });
    const buf = await binRes.arrayBuffer();
    await writeFile(destPath, new Uint8Array(buf));
    if (process.platform !== "win32") {
      await chmod(destPath, 0o755);
    }

    return true;
  } catch {
    return false;
  }
}

export class DependencyManager {
  async checkAll(): Promise<DependencyCheckResult[]> {
    const ids: DependencyId[] = [
      "adb",
      "fastboot",
      "libimobiledevice",
      "sideloader",
    ];
    return ids.map((id) => checkDependency(id));
  }

  async autoInstall(id: DependencyId): Promise<DependencyCheckResult> {
    // If already present, skip
    const existing = checkDependency(id);
    if (existing.status === "found") return existing;

    const platform = process.platform;
    let installed = false;

    switch (id) {
      case "adb":
      case "fastboot": {
        if (platform === "darwin") {
          installed = await runInstallCommand(
            "brew install android-platform-tools",
          );
        } else if (platform === "linux") {
          installed = await runInstallCommand(
            "apt-get install -y android-tools-adb android-tools-fastboot",
          );
        } else if (platform === "win32") {
          installed = await runInstallCommand(
            "winget install --silent Google.PlatformTools",
          );
        }
        break;
      }

      case "libimobiledevice": {
        if (platform === "darwin") {
          installed = await runInstallCommand("brew install libimobiledevice");
        } else if (platform === "linux") {
          installed = await runInstallCommand(
            "apt-get install -y libimobiledevice-utils",
          );
        } else if (platform === "win32") {
          // No native winget package — fall through to manual
          installed = false;
        }
        break;
      }

      case "sideloader": {
        if (platform === "win32") {
          // Try winget first, fall back to binary download
          installed = await runInstallCommand(
            "winget install --silent Dadoum.Sideloader",
          );
        }
        if (!installed) {
          installed = await downloadSideloader();
        }
        break;
      }
    }

    if (installed) {
      const result = checkDependency(id);
      // Even if check still fails (e.g. PATH not refreshed), return found status
      // if the install command claimed success.
      if (result.status === "found") return result;
      return { id, status: "found" };
    }

    return {
      id,
      status: "install-failed",
      errorMessage: `Auto-install failed on ${platform}. Please install manually.`,
      manualInstructions: getManualInstructions(id),
    };
  }

  getManualInstructions(id: DependencyId): ManualInstallInstructions {
    return getManualInstructions(id);
  }
}
