#!/usr/bin/env node
/**
 * Packages the Linux Electrobun build into distributable artifacts (.deb via
 * dpkg-deb, .rpm via rpmbuild, AppImage via appimagetool) under
 * platforms/electrobun/artifacts, normalizing package names to each format's
 * rules. Pass --format=deb, --format=rpm, or --format=appimage to build one;
 * omitting --format (or using --format=all) preserves the all-format build.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveLatestElectrobunLinuxBuild } from "./lib/electrobun-linux-build-dir.mjs";
import { hardenLinuxArtifactPermissions } from "./lib/linux-artifact-permissions.mjs";
import { normalizeAbsoluteStagedSymlinks } from "./lib/linux-artifact-symlinks.mjs";
import {
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
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

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
const channel = args.get("channel") ?? "stable";
const arch = args.get("arch") ?? "x64";
const debArch = arch === "arm64" ? "arm64" : "amd64";
const rpmArch = arch === "arm64" ? "aarch64" : "x86_64";

if (!["x64", "arm64"].includes(arch)) {
  throw new Error(
    `Unsupported Linux architecture "${arch}". Expected x64 or arm64.`,
  );
}

export const DIRECT_LINUX_PACKAGE_FORMATS = ["deb", "rpm", "appimage"];

// These are the host libraries used by the Electrobun wrapper, WebKit renderer,
// Secret Service integration, audio stack, and portable inference runtime. Keep
// the pre-t64 alternatives so the metadata remains valid on supported Ubuntu
// releases while preferring current Debian package names.
export const DEBIAN_RUNTIME_DEPENDS = [
  "libc6 (>= 2.38)",
  "libstdc++6",
  "libgcc-s1",
  "libglib2.0-0t64 | libglib2.0-0",
  "libgtk-3-0t64 | libgtk-3-0",
  "libgdk-pixbuf-2.0-0",
  "libcairo2",
  "libwebkit2gtk-4.1-0",
  "libjavascriptcoregtk-4.1-0",
  "libsoup-3.0-0",
  "libayatana-appindicator3-1",
  "libsecret-1-0", // gitleaks:allow Debian package name, not credential material
  "libasound2t64 | libasound2",
  "libvulkan1",
  "libgomp1",
  "libnss3",
  "libnspr4",
  "libx11-6",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxrandr2",
  "libatk1.0-0t64 | libatk1.0-0",
  "libatk-bridge2.0-0t64 | libatk-bridge2.0-0",
  "libcups2t64 | libcups2",
  "libgbm1",
  "libdrm2",
  "libxkbcommon0",
  "libdbus-1-3",
  "libexpat1",
  "libxcb1",
  "libpango-1.0-0",
  "libudev1",
  "libatspi2.0-0t64 | libatspi2.0-0",
  "ca-certificates",
  "xdg-utils",
];

export const DEBIAN_RUNTIME_RECOMMENDS = [
  "gstreamer1.0-plugins-base",
  "gstreamer1.0-plugins-good",
  "gstreamer1.0-libav",
  "gstreamer1.0-pipewire",
];

export const RPM_RUNTIME_REQUIRES = [
  "glibc >= 2.38",
  "libstdc++",
  "libgcc",
  "glib2",
  "gtk3",
  "gdk-pixbuf2",
  "cairo",
  "webkit2gtk4.1",
  "javascriptcoregtk4.1",
  "libsoup3",
  "libayatana-appindicator-gtk3",
  "libsecret",
  "alsa-lib",
  "vulkan-loader",
  "libgomp",
  "nss",
  "nspr",
  "libX11",
  "libXcomposite",
  "libXdamage",
  "libXext",
  "libXfixes",
  "libXrandr",
  "atk",
  "at-spi2-atk",
  "cups-libs",
  "mesa-libgbm",
  "libdrm",
  "libxkbcommon",
  "dbus-libs",
  "expat",
  "libxcb",
  "pango",
  "systemd-libs",
  "at-spi2-core",
  "ca-certificates",
  "xdg-utils",
];

// AppImageKit's continuous release is mutable. Pin both the observed asset
// update and SHA-256 so an upstream replacement fails closed instead of
// silently changing the produced artifact. Refresh these values deliberately.
export const APPIMAGETOOL_ASSETS = {
  x64: {
    asset: "appimagetool-x86_64.AppImage",
    sha256: "b90f4a8b18967545fda78a445b27680a1642f1ef9488ced28b65398f2be7add2",
    updatedAt: "2025-07-26T07:31:24Z",
  },
  arm64: {
    asset: "appimagetool-aarch64.AppImage",
    sha256: "a48972e5ae91c944c5a7c80214e7e0a42dd6aa3ae979d8756203512a74ff574d",
    updatedAt: "2025-07-26T07:31:24Z",
  },
};

/** Preserve the historical all-format build unless one format is requested. */
export function resolveLinuxPackageFormats(requestedFormat) {
  if (requestedFormat === undefined || requestedFormat === "all") {
    return [...DIRECT_LINUX_PACKAGE_FORMATS];
  }
  if (!DIRECT_LINUX_PACKAGE_FORMATS.includes(requestedFormat)) {
    throw new Error(
      `Unsupported Linux package format "${requestedFormat}". ` +
        `Expected one of: ${DIRECT_LINUX_PACKAGE_FORMATS.join(", ")}, all.`,
    );
  }
  return [requestedFormat];
}

// App identity is env-driven (mirroring the Electrobun shell's brand-config
// resolution) and defaults to the existing elizaOS values when unset, so the
// produced packages stay byte-identical unless the brand env is provided.
const displayName = (process.env.ELIZA_APP_NAME ?? "").trim() || "Eliza";
// Lowercase slug used for install paths, the launcher wrapper, the .desktop
// file, the icon, and (suffixed with `-app`) the deb/rpm package name.
// Defaults to "eliza". It must satisfy Debian package-name policy — start with
// an alphanumeric, then only [a-z0-9.+-] — or dpkg-deb/rpmbuild reject the
// control metadata with an opaque error, so validate the env value up front.
const namespace = (process.env.ELIZA_NAMESPACE ?? "").trim() || "eliza";
if (!/^[a-z0-9][a-z0-9.+-]+$/.test(namespace)) {
  throw new Error(
    `ELIZA_NAMESPACE "${namespace}" is not a valid Debian/RPM package name. ` +
      "Use lowercase letters, digits, '.', '+', or '-', at least two characters, " +
      'starting with a letter or digit (e.g. "acme" or "acme-desktop").',
  );
}
// System package name. Not derivable from the existing literal, so keep the
// literal fallback and derive from the namespace only when the env is set.
const packageName = (process.env.ELIZA_NAMESPACE ?? "").trim()
  ? `${namespace}-app`
  : "elizaos-app";
const optDir = `opt/${namespace}`;
const optPath = `/opt/${namespace}`;

function sh(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
}

function removePathRecursive(targetPath) {
  sh(process.execPath, [cleanupHelperScript, targetPath]);
}

/** Always reclaim the potentially multi-gigabyte package staging tree. */
export async function withStagingCleanup(targetPath, operation) {
  try {
    return await operation();
  } finally {
    if (existsSync(targetPath)) removePathRecursive(targetPath);
  }
}

function latestBuildDir() {
  return resolveLatestElectrobunLinuxBuild({
    buildRoot,
    explicitBuildDir: args.get("build-dir"),
    repoRoot,
  });
}

export function findElectrobunLauncher(root) {
  const directLauncher = path.join(root, "bin", "launcher");
  const nestedLaunchers = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "bin", "launcher"))
    .sort();
  const launcher = [directLauncher, ...nestedLaunchers].find(
    (candidate) =>
      existsSync(candidate) && (statSync(candidate).mode & 0o111) !== 0,
  );
  if (!launcher) {
    throw new Error(
      `Could not find executable Electrobun bin/launcher under ${root}`,
    );
  }
  return launcher;
}

function writeDesktopFile(dest, execName = namespace) {
  writeFileSync(
    dest,
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${displayName}`,
      `Comment=Your ${displayName}, everywhere.`,
      `Exec=${execName}`,
      `Icon=${namespace}`,
      "Terminal=false",
      "Categories=Network;",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
}

function posixShellQuote(value) {
  if (value.includes("\0")) {
    throw new Error("Linux launcher path contains a null byte.");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderLinuxLauncherWrapper(absoluteExecutable) {
  return `#!/usr/bin/env sh\nexec ${posixShellQuote(absoluteExecutable)} "$@"\n`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function stageAppImageMetadata(
  appDir,
  relativeExecutable = "bin/launcher",
) {
  const appStreamId = `ai.elizaos.${namespace}`;
  const appImageDesktopId = `${appStreamId}.desktop`;
  const stagedDesktopPath = path.join(
    appDir,
    `usr/share/applications/${namespace}.desktop`,
  );
  const installedDesktopPath = path.join(
    appDir,
    `usr/share/applications/${appImageDesktopId}`,
  );
  const desktopPath = path.join(appDir, appImageDesktopId);
  renameSync(stagedDesktopPath, installedDesktopPath);
  chmodSync(installedDesktopPath, 0o644);
  copyFileSync(installedDesktopPath, desktopPath);
  chmodSync(desktopPath, 0o644);

  if (existsSync(iconPath)) {
    const appImageIcon = path.join(appDir, `${namespace}.png`);
    copyFileSync(iconPath, appImageIcon);
    chmodSync(appImageIcon, 0o644);
  }

  const metainfoDir = path.join(appDir, "usr/share/metainfo");
  mkdirSync(metainfoDir, { recursive: true });
  const metainfoPath = path.join(metainfoDir, `${appStreamId}.appdata.xml`);
  writeFileSync(
    metainfoPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<component type="desktop-application">',
      `  <id>${appStreamId}</id>`,
      `  <name>${escapeXml(displayName)}</name>`,
      `  <summary>Your ${escapeXml(displayName)}, everywhere</summary>`,
      "  <metadata_license>CC0-1.0</metadata_license>",
      "  <project_license>MIT</project_license>",
      '  <developer id="ai.elizaos"><name>elizaOS</name></developer>',
      `  <launchable type="desktop-id">${appImageDesktopId}</launchable>`,
      "  <description>",
      `    <p>The ${escapeXml(displayName)} desktop app brings chat, account setup, connected devices, and remote runtimes together in one native Linux experience.</p>`,
      "  </description>",
      '  <url type="homepage">https://elizaos.ai</url>',
      '  <url type="bugtracker">https://github.com/elizaOS/eliza/issues</url>',
      '  <content_rating type="oars-1.1" />',
      "</component>",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  writeFileSync(
    path.join(appDir, "AppRun"),
    renderAppImageLauncher(relativeExecutable),
    { mode: 0o755 },
  );
}

export function renderAppImageLauncher(relativeExecutable = "bin/launcher") {
  const posixExecutable = relativeExecutable.split(path.sep).join("/");
  const bundleRoot = path.posix.dirname(path.posix.dirname(posixExecutable));
  const payloadRoot = path.posix.join(optDir, bundleRoot);
  const nativeWrapper = path.posix.join(payloadRoot, "bin/libNativeWrapper.so");
  const cefLibrary = path.posix.join(payloadRoot, "bin/cef/libcef.so");
  const inferenceLibrary = path.posix.join(
    payloadRoot,
    "Resources/app/eliza-dist/local-inference/lib/libelizainference.so",
  );
  return [
    "#!/usr/bin/env sh",
    'HERE="$(dirname "$(readlink -f "$0")")"',
    `PAYLOAD_ROOT="$HERE"/${posixShellQuote(payloadRoot)}`,
    'INFERENCE_LIB="$PAYLOAD_ROOT/Resources/app/eliza-dist/local-inference/lib"',
    `export LD_LIBRARY_PATH="$PAYLOAD_ROOT/bin:$INFERENCE_LIB\${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"`,
    "if command -v ldd >/dev/null 2>&1; then",
    `  for library in "$HERE"/${posixShellQuote(nativeWrapper)} "$HERE"/${posixShellQuote(cefLibrary)} "$HERE"/${posixShellQuote(inferenceLibrary)}; do`,
    '    [ -f "$library" ] || continue',
    '    missing="$(ldd "$library" 2>/dev/null | awk \'/=> not found/{print $1}\' | sort -u)"',
    '    if [ -n "$missing" ]; then',
    "      printf >&2 'Eliza cannot start because Linux runtime libraries are missing:\\n%s\\nSee packages/app-core/docs/linux-development.md for supported hosts.\\n' \"$missing\"",
    "      exit 127",
    "    fi",
    "  done",
    "fi",
    `exec "$HERE"/${posixShellQuote(
      path.posix.join(optDir, posixExecutable),
    )} "$@"`,
    "",
  ].join("\n");
}

export function renderDebianControl() {
  return [
    `Package: ${packageName}`,
    `Version: ${version.replace(/-/g, "~")}`,
    "Section: utils",
    "Priority: optional",
    `Architecture: ${debArch}`,
    "Maintainer: elizaOS <hello@elizaos.ai>",
    `Depends: ${DEBIAN_RUNTIME_DEPENDS.join(", ")}`,
    `Recommends: ${DEBIAN_RUNTIME_RECOMMENDS.join(", ")}`,
    `Description: ${displayName} desktop app`,
    ` The consumer ${displayName} app for desktop chat, account setup, and connected devices.`,
    "",
  ].join("\n");
}

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function resolveAppImageToolAsset(targetArch, hostArch = process.arch) {
  const asset = APPIMAGETOOL_ASSETS[targetArch];
  if (!asset) {
    throw new Error(`No pinned appimagetool asset for Linux ${targetArch}.`);
  }
  if (hostArch !== targetArch) {
    throw new Error(
      `AppImage packaging is native-only: target ${targetArch}, host ${hostArch}.`,
    );
  }
  return asset;
}

function ensureVerifiedAppImageTool(targetArch) {
  const asset = resolveAppImageToolAsset(targetArch);
  const fingerprint = asset.sha256.slice(0, 16);
  const tool = path.join(os.tmpdir(), `${asset.asset}-${fingerprint}`);
  if (existsSync(tool) && sha256File(tool) === asset.sha256) return tool;

  const download = `${tool}.download-${process.pid}`;
  try {
    sh("curl", [
      "-fsSL",
      `https://github.com/AppImage/AppImageKit/releases/download/continuous/${asset.asset}`,
      "-o",
      download,
    ]);
    const actual = sha256File(download);
    if (actual !== asset.sha256) {
      throw new Error(
        `appimagetool SHA-256 mismatch for ${asset.asset}: expected ${asset.sha256}, got ${actual}.`,
      );
    }
    chmodSync(download, 0o755);
    renameSync(download, tool);
  } finally {
    if (existsSync(download)) removePathRecursive(download);
  }
  return tool;
}

export function debArchiveBuildArgs(packageRoot, outputPath) {
  return ["--root-owner-group", "--build", packageRoot, outputPath];
}

export async function stagePackageRoot(buildDir, destRoot) {
  removePathRecursive(destRoot);
  mkdirSync(path.join(destRoot, optDir), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/bin"), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/share/applications"), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/share/icons/hicolor/512x512/apps"), {
    recursive: true,
  });

  await cp(buildDir, path.join(destRoot, optDir), {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  normalizeAbsoluteStagedSymlinks(buildDir, path.join(destRoot, optDir));

  const executable = findElectrobunLauncher(path.join(destRoot, optDir));
  const relativeExecutable = path.relative(
    path.join(destRoot, optDir),
    executable,
  );
  writeFileSync(
    path.join(destRoot, `usr/bin/${namespace}`),
    renderLinuxLauncherWrapper(
      path.posix.join(optPath, relativeExecutable.split(path.sep).join("/")),
    ),
    { mode: 0o755 },
  );
  writeDesktopFile(
    path.join(destRoot, `usr/share/applications/${namespace}.desktop`),
  );
  if (existsSync(iconPath)) {
    copyFileSync(
      iconPath,
      path.join(
        destRoot,
        `usr/share/icons/hicolor/512x512/apps/${namespace}.png`,
      ),
    );
    chmodSync(
      path.join(
        destRoot,
        `usr/share/icons/hicolor/512x512/apps/${namespace}.png`,
      ),
      0o644,
    );
  }
  hardenLinuxArtifactPermissions(destRoot);
  return relativeExecutable;
}

async function buildDeb(buildDir) {
  const root = path.join(os.tmpdir(), `${namespace}-deb-${process.pid}`);
  return withStagingCleanup(root, async () => {
    await stagePackageRoot(buildDir, root);
    const controlDir = path.join(root, "DEBIAN");
    mkdirSync(controlDir, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(controlDir, "control"), renderDebianControl(), {
      mode: 0o644,
    });
    hardenLinuxArtifactPermissions(root);
    const out = path.join(
      artifactRoot,
      `${packageName}_${version}_${debArch}.deb`,
    );
    sh("dpkg-deb", debArchiveBuildArgs(root, out));
    return out;
  });
}

async function buildRpm(buildDir) {
  const top = path.join(os.tmpdir(), `${namespace}-rpm-${process.pid}`);
  const buildroot = path.join(top, `BUILDROOT/${packageName}`);
  return withStagingCleanup(top, async () => {
    await stagePackageRoot(buildDir, buildroot);
    for (const dir of ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
      mkdirSync(path.join(top, dir), { recursive: true });
    }
    const rpmVersion = version.replace(/-.*/, "");
    const rpmRelease = version.includes("-")
      ? version.replace(/^[^-]+-/, "").replace(/[^A-Za-z0-9.]/g, ".")
      : "1";
    const spec = path.join(top, `SPECS/${packageName}.spec`);
    writeFileSync(
      spec,
      [
        `Name: ${packageName}`,
        `Version: ${rpmVersion}`,
        `Release: ${rpmRelease}%{?dist}`,
        `Summary: ${displayName} desktop app`,
        "License: MIT",
        `BuildArch: ${rpmArch}`,
        ...RPM_RUNTIME_REQUIRES.map((dependency) => `Requires: ${dependency}`),
        "",
        "%description",
        `The consumer ${displayName} app for desktop chat, account setup, and connected devices.`,
        "",
        "%install",
        "mkdir -p %{buildroot}",
        `cp -a ${buildroot}/* %{buildroot}/`,
        "",
        "%files",
        optPath,
        `/usr/bin/${namespace}`,
        `/usr/share/applications/${namespace}.desktop`,
        `/usr/share/icons/hicolor/512x512/apps/${namespace}.png`,
        "",
      ].join("\n"),
    );
    sh("rpmbuild", ["--define", `_topdir ${top}`, "-bb", spec]);
    const rpmDir = path.join(top, "RPMS", rpmArch);
    const rpm = readdirSync(rpmDir).find((name) => name.endsWith(".rpm"));
    if (!rpm) throw new Error("rpmbuild did not produce an rpm");
    const out = path.join(
      artifactRoot,
      `${packageName}-${version}.${rpmArch}.rpm`,
    );
    copyFileSync(path.join(rpmDir, rpm), out);
    return out;
  });
}

async function buildAppImage(buildDir) {
  const appDir = path.join(os.tmpdir(), `${displayName}.AppDir-${process.pid}`);
  return withStagingCleanup(appDir, async () => {
    const relativeExecutable = await stagePackageRoot(buildDir, appDir);
    stageAppImageMetadata(appDir, relativeExecutable);
    hardenLinuxArtifactPermissions(appDir);

    const tool = ensureVerifiedAppImageTool(arch);
    const out = path.join(
      artifactRoot,
      `${displayName}-${version}-linux-${arch}.AppImage`,
    );
    sh(tool, [appDir, out], {
      env: { ...process.env, ARCH: rpmArch, APPIMAGE_EXTRACT_AND_RUN: "1" },
    });
    return out;
  });
}

export async function buildSelectedLinuxPackages(
  buildDir,
  formats,
  builders = {
    deb: buildDeb,
    rpm: buildRpm,
    appimage: buildAppImage,
  },
) {
  const outputs = [];
  for (const format of formats) {
    outputs.push(await builders[format](buildDir));
  }
  return outputs;
}

async function main() {
  const formats = resolveLinuxPackageFormats(args.get("format"));
  mkdirSync(artifactRoot, { recursive: true });
  const buildDir = latestBuildDir();
  const inspection = assertLinuxDistributionClaim({
    buildDir,
    claim: LINUX_DISTRIBUTION_CLAIMS.PRODUCTION_DIRECT,
  });
  console.log(`Packaging Linux Electrobun build: ${buildDir}`);
  console.log(`Version: ${version}; channel: ${channel}; arch: ${arch}`);
  console.log(`Formats: ${formats.join(", ")}`);
  console.log(
    `ELF ABI: ${inspection.glibcCompatibility.elfFileCount} files, maximum GLIBC_${inspection.glibcCompatibility.maxRequiredVersion ?? "none"} (ceiling GLIBC_${inspection.glibcCompatibility.maxAllowedVersion})`,
  );

  const outputs = await buildSelectedLinuxPackages(buildDir, formats);
  for (const output of outputs) {
    console.log(`Wrote ${path.relative(repoRoot, output)}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
