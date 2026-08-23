#!/usr/bin/env node
/**
 * Packages the already-built Linux Electrobun application tree as a
 * side-loadable Flatpak, preserving the exact desktop runtime tested by the
 * canonical release lane instead of substituting the command-line package.
 * Pass --artifact-dir=/path/to/output to place the final bundle and its
 * filesystem-capacity preflight outside the repository.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { hardenLinuxArtifactPermissions } from "./lib/linux-artifact-permissions.mjs";
import {
  assertFinalizedFlatpakMetadata,
  assertFlatpakPackagingSpace,
  assertLinuxDistributionClaim,
  LINUX_DISTRIBUTION_CLAIMS,
} from "./linux-distribution-contract.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const electrobunRoot = path.join(
  repoRoot,
  "packages/app-core/platforms/electrobun",
);
const buildRoot = path.join(electrobunRoot, "build");
const artifactRoot = path.join(electrobunRoot, "artifacts");
const iconPath = path.join(electrobunRoot, "assets/appIcon.png");
const cleanupHelper = path.join(
  repoRoot,
  "packages/scripts/rm-path-recursive.mjs",
);

const APP_ID = "ai.elizaos.app";
export const FLATPAK_RUNTIME = {
  platform: "org.gnome.Platform",
  sdk: "org.gnome.Sdk",
  version: "49",
};
export const FLATPAK_BUNDLED_LIBRARIES = [
  {
    package: "libayatana-appindicator3-1",
    soname: "libayatana-appindicator3.so.1",
  },
  {
    package: "libayatana-indicator3-7",
    soname: "libayatana-indicator3.so.7",
  },
  {
    package: "libayatana-ido3-0.4-0",
    soname: "libayatana-ido3-0.4.so.0",
  },
  { package: "libdbusmenu-glib4", soname: "libdbusmenu-glib.so.4" },
  { package: "libdbusmenu-gtk3-4", soname: "libdbusmenu-gtk3.so.4" },
];
export const FLATPAK_FINISH_ARGS = [
  "--command=eliza",
  "--share=network",
  "--share=ipc",
  "--socket=wayland",
  "--socket=fallback-x11",
  "--socket=pulseaudio",
  "--device=dri",
];

/** Resolve explicit full refs without silently changing the target architecture. */
export function resolveFlatpakRefs({ arch, runtimeRef, sdkRef }) {
  const resolvedRuntimeRef =
    runtimeRef ??
    `${FLATPAK_RUNTIME.platform}/${arch}/${FLATPAK_RUNTIME.version}`;
  const resolvedSdkRef =
    sdkRef ?? `${FLATPAK_RUNTIME.sdk}/${arch}/${FLATPAK_RUNTIME.version}`;
  const runtimeMatch = resolvedRuntimeRef.match(
    /^(org\.gnome\.Platform)\/(x86_64|aarch64)\/([^/]+)$/,
  );
  const sdkMatch = resolvedSdkRef.match(
    /^(org\.gnome\.Sdk|org\.freedesktop\.Sdk)\/(x86_64|aarch64)\/([^/]+)$/,
  );
  if (!runtimeMatch) {
    throw new Error(
      `Flatpak runtime ref must be a full org.gnome.Platform ref: ${resolvedRuntimeRef}`,
    );
  }
  if (!sdkMatch) {
    throw new Error(
      `Flatpak SDK ref must be a full GNOME or Freedesktop SDK ref: ${resolvedSdkRef}`,
    );
  }
  if (runtimeMatch[2] !== arch || sdkMatch[2] !== arch) {
    throw new Error(
      `Flatpak runtime and SDK refs must target requested architecture ${arch}`,
    );
  }
  return { runtimeRef: resolvedRuntimeRef, sdkRef: resolvedSdkRef };
}

function lstatIfPresent(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve an optional artifact directory and the existing directory whose
 * filesystem capacity represents it. Explicit paths reject symlink traversal,
 * filesystem roots, the repository root, and non-directory components.
 */
export function resolveFlatpakArtifactDirectory(
  requestedDirectory,
  {
    baseDirectory = repoRoot,
    defaultDirectory = artifactRoot,
    defaultCapacityDirectory = electrobunRoot,
  } = {},
) {
  if (requestedDirectory === undefined) {
    return {
      artifactDirectory: defaultDirectory,
      capacityDirectory: defaultCapacityDirectory,
    };
  }
  if (
    requestedDirectory === "true" ||
    requestedDirectory.trim().length === 0 ||
    requestedDirectory.includes("\0")
  ) {
    throw new Error(
      "--artifact-dir requires a non-empty directory path supplied with =",
    );
  }

  const resolvedBase = path.resolve(baseDirectory);
  const artifactDirectory = path.resolve(resolvedBase, requestedDirectory);
  if (artifactDirectory === path.parse(artifactDirectory).root) {
    throw new Error("Flatpak artifact directory must not be a filesystem root");
  }
  if (artifactDirectory === resolvedBase) {
    throw new Error(
      "Flatpak artifact directory must not be the repository root",
    );
  }

  let capacityDirectory = artifactDirectory;
  while (true) {
    const stats = lstatIfPresent(capacityDirectory);
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new Error(
          `Flatpak artifact directory must not traverse a symlink: ${capacityDirectory}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new Error(
          `Flatpak artifact directory component is not a directory: ${capacityDirectory}`,
        );
      }
      if (realpathSync(capacityDirectory) !== capacityDirectory) {
        throw new Error(
          `Flatpak artifact directory must not traverse a symlink: ${capacityDirectory}`,
        );
      }
      break;
    }
    const parent = path.dirname(capacityDirectory);
    if (parent === capacityDirectory) {
      throw new Error(
        `Flatpak artifact directory has no existing directory ancestor: ${artifactDirectory}`,
      );
    }
    capacityDirectory = parent;
  }

  return { artifactDirectory, capacityDirectory };
}

/** Keep output outside the multi-gigabyte source tree being copied. */
export function assertFlatpakArtifactDirectoryOutsideBuild(
  artifactDirectory,
  buildDirectory,
) {
  const canonicalBuildDirectory = realpathSync(buildDirectory);
  const relative = path.relative(canonicalBuildDirectory, artifactDirectory);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  ) {
    throw new Error(
      `Flatpak artifact directory must not be inside the build tree: ${artifactDirectory}`,
    );
  }
  return artifactDirectory;
}

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);
const version =
  args.get("version") ??
  JSON.parse(readFileSync(path.join(electrobunRoot, "package.json"), "utf8"))
    .version;
const arch = args.get("arch") ?? "x86_64";
const flatpakRefs = resolveFlatpakRefs({
  arch,
  runtimeRef: args.get("runtime-ref"),
  sdkRef: args.get("sdk-ref"),
});
const releaseDate =
  args.get("release-date") ??
  execFileSync("git", ["show", "-s", "--format=%cs", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
}

/** Always reclaim Flatpak app and OSTree staging after success or failure. */
export async function withFlatpakStagingCleanup(tempRoot, operation) {
  try {
    return await operation();
  } finally {
    if (existsSync(tempRoot)) {
      run(process.execPath, [cleanupHelper, tempRoot]);
    }
  }
}

function latestLinuxBuildDir() {
  const explicit = args.get("build-dir");
  if (explicit) return path.resolve(repoRoot, explicit);

  const candidates = readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /linux/i.test(entry.name))
    .map((entry) => path.join(buildRoot, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!candidates[0]) {
    throw new Error(`No Linux Electrobun build found under ${buildRoot}`);
  }
  return candidates[0];
}

export function requireLauncher(buildDir) {
  const candidates = [
    path.join(buildDir, "bin", "launcher"),
    ...readdirSync(buildDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(buildDir, entry.name, "bin", "launcher")),
  ];
  const launcher = candidates.find((candidate) => existsSync(candidate));
  if (!launcher || (statSync(launcher).mode & 0o111) === 0) {
    throw new Error(
      `The Electrobun build has no executable bin/launcher: ${buildDir}`,
    );
  }
  return path.relative(buildDir, launcher);
}

function posixShellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Close umask-dependent write permissions across the completed Flatpak stage. */
export function hardenFlatpakStagingPermissions(appDir) {
  return hardenLinuxArtifactPermissions(appDir);
}

export async function writeMetadata(filesDir, relativeLauncher) {
  mkdirSync(path.join(filesDir, "bin"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/applications"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/metainfo"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/icons/hicolor/512x512/apps"), {
    recursive: true,
  });

  const wrapper = path.join(filesDir, "bin/eliza");
  const launcherPath = path.posix.join(
    "/app/opt/eliza",
    relativeLauncher.split(path.sep).join("/"),
  );
  writeFileSync(
    wrapper,
    `#!/usr/bin/env sh\nexec ${posixShellQuote(launcherPath)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  writeFileSync(
    path.join(filesDir, `share/applications/${APP_ID}.desktop`),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Eliza",
      "Comment=Your AI assistant, everywhere.",
      "Exec=eliza",
      `Icon=${APP_ID}`,
      "Terminal=false",
      "Categories=Utility;Network;",
      "StartupNotify=true",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(filesDir, `share/metainfo/${APP_ID}.metainfo.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<component type="desktop-application">\n` +
      `  <id>${APP_ID}</id>\n` +
      `  <metadata_license>MIT</metadata_license>\n` +
      `  <project_license>MIT</project_license>\n` +
      `  <name>Eliza</name>\n` +
      `  <summary>Your AI assistant, everywhere</summary>\n` +
      `  <developer id="ai.elizaos"><name>elizaOS</name></developer>\n` +
      `  <description><p>Eliza is the elizaOS desktop application for chat, account setup, agents, and connected services.</p></description>\n` +
      `  <url type="homepage">https://elizaos.ai</url>\n` +
      `  <url type="bugtracker">https://github.com/elizaOS/eliza/issues</url>\n` +
      `  <launchable type="desktop-id">${APP_ID}.desktop</launchable>\n` +
      `  <provides><binary>eliza</binary></provides>\n` +
      `  <categories><category>Utility</category><category>Network</category></categories>\n` +
      `  <releases><release version="${version}" date="${releaseDate}"/></releases>\n` +
      `  <content_rating type="oars-1.1"/>\n` +
      `</component>\n`,
  );
  await sharp(iconPath)
    .resize(512, 512, { fit: "contain" })
    .png()
    .toFile(
      path.join(filesDir, `share/icons/hicolor/512x512/apps/${APP_ID}.png`),
    );
}

/** Bundle the tray libraries Electrobun links but the GNOME runtime omits. */
export function copyBundledLibraries(filesDir) {
  const cache = execFileSync("ldconfig", ["-p"], { encoding: "utf8" });
  const libraryDir = path.join(filesDir, "lib");
  const licenseDir = path.join(filesDir, "share/licenses/eliza-bundled");
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(licenseDir, { recursive: true });

  for (const library of FLATPAK_BUNDLED_LIBRARIES) {
    const line = cache
      .split("\n")
      .find((candidate) =>
        candidate.trimStart().startsWith(`${library.soname} `),
      );
    const source = line?.match(/=>\s+(\S+)\s*$/)?.[1];
    if (!source || !existsSync(source)) {
      throw new Error(`Missing required Flatpak library ${library.soname}`);
    }
    const copyright = path.join("/usr/share/doc", library.package, "copyright");
    if (!existsSync(copyright)) {
      throw new Error(`Missing license for bundled package ${library.package}`);
    }
    copyFileSync(source, path.join(libraryDir, library.soname));
    copyFileSync(
      copyright,
      path.join(licenseDir, `${library.package}.copyright`),
    );
  }
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error(
      `Flatpak packaging requires Linux, got ${process.platform}`,
    );
  }
  if (!existsSync(iconPath)) throw new Error(`Missing app icon: ${iconPath}`);
  const { artifactDirectory, capacityDirectory } =
    resolveFlatpakArtifactDirectory(args.get("artifact-dir"));
  const output = path.join(
    artifactDirectory,
    `Eliza-${version}-linux-${arch}.flatpak`,
  );
  if (existsSync(output)) {
    throw new Error(
      `Refusing to overwrite existing Flatpak artifact: ${output}`,
    );
  }

  const buildDir = latestLinuxBuildDir();
  assertFlatpakArtifactDirectoryOutsideBuild(artifactDirectory, buildDir);
  const relativeLauncher = requireLauncher(buildDir);
  const inspection = assertLinuxDistributionClaim({
    buildDir,
    claim: LINUX_DISTRIBUTION_CLAIMS.FLATPAK_OUTER_SANDBOX,
    finishArgs: FLATPAK_FINISH_ARGS,
  });
  // The output bundle lives with the Electrobun artifacts even when staging
  // uses a separate tmpfs. Gate both filesystems before creating either copy.
  const space = assertFlatpakPackagingSpace(
    buildDir,
    capacityDirectory,
    inspection,
  );
  assertFlatpakPackagingSpace(buildDir, os.tmpdir(), inspection);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "eliza-flatpak-"));
  const appDir = path.join(tempRoot, "app");
  const repoDir = path.join(tempRoot, "repo");

  await withFlatpakStagingCleanup(tempRoot, async () => {
    run("flatpak", [
      "build-init",
      "--type=app",
      `--arch=${arch}`,
      appDir,
      APP_ID,
      flatpakRefs.sdkRef,
      flatpakRefs.runtimeRef,
    ]);
    await cp(buildDir, path.join(appDir, "files/opt/eliza"), {
      recursive: true,
      force: true,
      dereference: true,
    });
    copyBundledLibraries(path.join(appDir, "files"));
    await writeMetadata(path.join(appDir, "files"), relativeLauncher);
    run("flatpak", ["build-finish", ...FLATPAK_FINISH_ARGS, appDir]);
    hardenFlatpakStagingPermissions(appDir);
    assertFinalizedFlatpakMetadata(path.join(appDir, "metadata"), flatpakRefs);
    run("flatpak", [
      "build-export",
      `--arch=${arch}`,
      repoDir,
      appDir,
      "stable",
    ]);
    mkdirSync(artifactDirectory, { recursive: true });
    run("flatpak", [
      "build-bundle",
      `--arch=${arch}`,
      repoDir,
      output,
      APP_ID,
      "stable",
    ]);
    console.log(
      `Wrote ${path.relative(repoRoot, output)} (outer Flatpak sandbox verified; ${inspection.glibcCompatibility.elfFileCount} ELF files at or below GLIBC_${inspection.glibcCompatibility.maxAllowedVersion}; Chromium renderer sandbox unavailable; preflight required ${space.requiredBytes} free bytes)`,
    );
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `[package-electrobun-flatpak] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
