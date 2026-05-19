import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Dependency,
  DependencyCheckResult,
  DependencyId,
  ManualInstallInstructions,
} from "./types";

export type LinuxDistroFamily =
  | "debian"
  | "fedora"
  | "arch"
  | "suse"
  | "alpine"
  | "unknown";

export function detectLinuxDistro(): LinuxDistroFamily {
  if (process.platform !== "linux") return "unknown";
  if (existsSync("/etc/debian_version")) return "debian";
  if (existsSync("/etc/redhat-release")) return "fedora";
  if (existsSync("/etc/arch-release")) return "arch";
  if (existsSync("/etc/SUSE-brand") || existsSync("/etc/SuSE-release"))
    return "suse";
  if (existsSync("/etc/alpine-release")) return "alpine";
  return "unknown";
}

interface LinuxInstallSpec {
  distro: LinuxDistroFamily;
  installCommand: string[];
  packages: string[];
}

const LINUX_PACKAGE_MAP: Record<
  "adb" | "fastboot" | "libimobiledevice",
  Partial<Record<LinuxDistroFamily, string[]>>
> = {
  adb: {
    debian: ["android-tools-adb"],
    fedora: ["android-tools"],
    arch: ["android-tools"],
    suse: ["android-tools"],
    alpine: ["android-tools"],
  },
  fastboot: {
    debian: ["android-tools-fastboot"],
    fedora: ["android-tools"],
    arch: ["android-tools"],
    suse: ["android-tools"],
    alpine: ["android-tools"],
  },
  libimobiledevice: {
    debian: ["libimobiledevice-utils"],
    fedora: ["libimobiledevice-utils"],
    arch: ["libimobiledevice"],
    suse: ["libimobiledevice"],
    alpine: ["libimobiledevice"],
  },
};

const LINUX_INSTALL_COMMANDS: Record<
  Exclude<LinuxDistroFamily, "unknown">,
  string[]
> = {
  debian: ["apt-get", "install", "-y"],
  fedora: ["dnf", "install", "-y"],
  arch: ["pacman", "-S", "--noconfirm"],
  suse: ["zypper", "install", "-y"],
  alpine: ["apk", "add"],
};

function getLinuxInstallSpec(
  depKey: keyof typeof LINUX_PACKAGE_MAP,
): LinuxInstallSpec | null {
  const distro = detectLinuxDistro();
  if (distro === "unknown") return null;
  const packages = LINUX_PACKAGE_MAP[depKey][distro];
  if (!packages) return null;
  return { distro, installCommand: LINUX_INSTALL_COMMANDS[distro], packages };
}

const LIBIMOBILEDEVICE_UDEV_RULE =
  "/etc/udev/rules.d/39-libimobiledevice.rules";

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

/**
 * Run a command with an explicit argv array. Never string-interpolates user
 * input into a shell; arguments containing spaces, quotes, or shell
 * metacharacters are safe.
 */
function runCommand(
  binary: string,
  args: string[] = [],
): { stdout: string; success: boolean } {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
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
  const result =
    process.platform === "win32"
      ? runCommand("where", [name])
      : runCommand("which", [name]);
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
  const result = runCommand(foundPath, [flag]);
  if (result.success && result.stdout.length > 0) {
    // First non-empty line usually contains the version
    return result.stdout.split("\n")[0]?.trim();
  }
  return undefined;
}

function checkDependency(
  id: DependencyId,
  which: (name: string) => string | undefined = whichBinary,
): DependencyCheckResult {
  const def = DEPENDENCY_DEFINITIONS[id];
  // For deps with multiple commands, require all of them
  const paths: string[] = [];
  for (const cmd of def.commands) {
    const found = which(cmd);
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

  // On Linux, libimobiledevice without the udev rules can't talk to an iPhone
  // as non-root. Mark it as found-but-misconfigured if rules are missing.
  if (
    id === "libimobiledevice" &&
    process.platform === "linux" &&
    !existsSync(LIBIMOBILEDEVICE_UDEV_RULE)
  ) {
    result.status = "found-but-misconfigured";
    result.errorMessage = `Missing udev rules at ${LIBIMOBILEDEVICE_UDEV_RULE}. Install/start usbmuxd (e.g. \`sudo systemctl enable --now usbmuxd\`) or run \`sudo usbmuxd -X\` to populate them.`;
    result.manualInstructions = getManualInstructions(id);
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
        const distro = detectLinuxDistro();
        const steps: Record<LinuxDistroFamily, string> = {
          debian:
            "Run: sudo apt update && sudo apt install android-tools-adb android-tools-fastboot",
          fedora: "Run: sudo dnf install android-tools",
          arch: "Run: sudo pacman -S android-tools",
          suse: "Run: sudo zypper install android-tools",
          alpine: "Run: sudo apk add android-tools",
          unknown:
            "No supported package manager detected. Download from: https://developer.android.com/tools/releases/platform-tools",
        };
        return {
          title: `Install Android Platform Tools (Linux/${distro})`,
          steps: [
            steps[distro],
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
        const distro = detectLinuxDistro();
        const steps: Record<LinuxDistroFamily, string> = {
          debian:
            "Run: sudo apt update && sudo apt install libimobiledevice-utils usbmuxd",
          fedora: "Run: sudo dnf install libimobiledevice-utils usbmuxd",
          arch: "Run: sudo pacman -S libimobiledevice usbmuxd",
          suse: "Run: sudo zypper install libimobiledevice usbmuxd",
          alpine: "Run: sudo apk add libimobiledevice usbmuxd",
          unknown:
            "No supported package manager detected; install libimobiledevice + usbmuxd from your distro.",
        };
        return {
          title: `Install libimobiledevice (Linux/${distro})`,
          steps: [
            steps[distro],
            "Ensure usbmuxd is running so udev rules under /etc/udev/rules.d/39-libimobiledevice.rules are honored.",
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

async function runInstallCommand(argv: string[]): Promise<boolean> {
  if (argv.length === 0) return false;
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * winget ships in App Installer, which is missing on pre-1809 Windows 10,
 * Server 2019, and some enterprise images. Probe before assuming we can use it.
 */
async function isWingetAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const proc = Bun.spawn(
      [
        "powershell.exe",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        "if (Get-Command winget -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return false;
    const text = await new Response(proc.stdout).text();
    return text.trim() === "yes";
  } catch {
    return false;
  }
}

/**
 * Direct download fallback for Android platform-tools when winget is missing.
 * Pulls the official Google zip and extracts adb/fastboot into the vendor bin
 * directory (which is searched before PATH by `whichBinary`).
 */
async function downloadPlatformTools(): Promise<boolean> {
  const url =
    "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    await mkdir(VENDOR_BIN_DIR, { recursive: true });
    const zipPath = join(VENDOR_BIN_DIR, "platform-tools.zip");
    await writeFile(zipPath, buf);
    const psSafe = (s: string): string => `'${s.replace(/'/g, "''")}'`;
    const proc = Bun.spawn(
      [
        "powershell.exe",
        "-NonInteractive",
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference = "Stop"; Expand-Archive -Force -Path ${psSafe(zipPath)} -DestinationPath ${psSafe(VENDOR_BIN_DIR)}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    await rm(zipPath, { force: true }).catch(() => undefined);
    return code === 0;
  } catch {
    return false;
  }
}

async function downloadSideloader(): Promise<boolean> {
  const apiUrl =
    "https://api.github.com/repos/Dadoum/Sideloader/releases/latest";
  try {
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "elizaos-setup/1.0" },
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

/**
 * Probes the DependencyManager uses to talk to the host system. Injectable so
 * tests (and any caller that wants a virtual environment) can simulate a host
 * without actually touching `which` or invoking a package manager.
 *
 * Both default to the real implementations; partial overrides are merged.
 */
export interface DependencyManagerProbes {
  /** Locate a binary by name. Mirrors `which`/`where`. */
  whichBinary: (name: string) => string | undefined;
  /** Run an install argv. Resolves true iff the command exited 0. */
  runInstallCommand: (argv: string[]) => Promise<boolean>;
}

const DEFAULT_PROBES: DependencyManagerProbes = {
  whichBinary,
  runInstallCommand,
};

export class DependencyManager {
  private readonly probes: DependencyManagerProbes;

  constructor(probes: Partial<DependencyManagerProbes> = {}) {
    this.probes = { ...DEFAULT_PROBES, ...probes };
  }

  async checkAll(): Promise<DependencyCheckResult[]> {
    const ids: DependencyId[] = [
      "adb",
      "fastboot",
      "libimobiledevice",
      "sideloader",
    ];
    return ids.map((id) => checkDependency(id, this.probes.whichBinary));
  }

  async checkOne(id: DependencyId): Promise<DependencyCheckResult> {
    return checkDependency(id, this.probes.whichBinary);
  }

  async autoInstall(id: DependencyId): Promise<DependencyCheckResult> {
    // If already present, skip
    const existing = checkDependency(id, this.probes.whichBinary);
    if (existing.status === "found") return existing;

    const platform = process.platform;
    let installed = false;

    switch (id) {
      case "adb":
      case "fastboot": {
        if (platform === "darwin") {
          installed = await this.probes.runInstallCommand([
            "brew",
            "install",
            "android-platform-tools",
          ]);
        } else if (platform === "linux") {
          installed = await this.runLinuxInstall(id);
        } else if (platform === "win32") {
          if (await isWingetAvailable()) {
            installed = await this.probes.runInstallCommand([
              "winget",
              "install",
              "--silent",
              "Google.PlatformTools",
            ]);
          }
          // Always try the direct download as a fallback (or as the primary
          // path when winget is unavailable). The vendor bin dir is searched
          // before PATH by whichBinary, so this puts adb/fastboot where the
          // dependency check expects them.
          if (!installed) {
            installed = await downloadPlatformTools();
          }
        }
        break;
      }

      case "libimobiledevice": {
        if (platform === "darwin") {
          installed = await this.probes.runInstallCommand([
            "brew",
            "install",
            "libimobiledevice",
          ]);
        } else if (platform === "linux") {
          installed = await this.runLinuxInstall("libimobiledevice");
        } else if (platform === "win32") {
          // No native winget package — fall through to manual
          installed = false;
        }
        break;
      }

      case "sideloader": {
        if (platform === "win32" && (await isWingetAvailable())) {
          installed = await this.probes.runInstallCommand([
            "winget",
            "install",
            "--silent",
            "Dadoum.Sideloader",
          ]);
        }
        if (!installed) {
          installed = await downloadSideloader();
        }
        break;
      }
    }

    if (installed) {
      // Always trust the post-install probe, not the installer's exit code.
      // brew/apt/winget can return 0 without putting the binary on PATH (e.g.
      // when a shim install fails silently, or when PATH needs a shell rehash).
      const result = checkDependency(id, this.probes.whichBinary);
      if (result.status === "found") return result;
      return {
        id,
        status: "install-failed",
        errorMessage: `Install command on ${platform} reported success, but '${id}' is still not on PATH. Open a new shell or install manually.`,
        manualInstructions: getManualInstructions(id),
      };
    }

    return {
      id,
      status: "install-failed",
      errorMessage: `Auto-install failed on ${platform}. Please install manually.`,
      manualInstructions: getManualInstructions(id),
    };
  }

  private async runLinuxInstall(
    depKey: keyof typeof LINUX_PACKAGE_MAP,
  ): Promise<boolean> {
    const spec = getLinuxInstallSpec(depKey);
    if (!spec) return false;
    const argv = ["sudo", "-n", ...spec.installCommand, ...spec.packages];
    if (await this.probes.runInstallCommand(argv)) return true;
    return this.probes.runInstallCommand([
      ...spec.installCommand,
      ...spec.packages,
    ]);
  }

  getManualInstructions(id: DependencyId): ManualInstallInstructions {
    return getManualInstructions(id);
  }
}
