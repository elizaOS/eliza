#!/usr/bin/env node
/**
 * Packages the Linux Electrobun build into distributable artifacts (.deb via
 * dpkg-deb, .rpm via rpmbuild, AppImage via appimagetool) under
 * platforms/electrobun/artifacts, normalizing package names to each format's
 * rules. Pass --format=deb, --format=rpm, or --format=appimage to build one;
 * omitting --format (or using --format=all) preserves the all-format build.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

export const DIRECT_LINUX_PACKAGE_FORMATS = ["deb", "rpm", "appimage"];

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
  const explicit = args.get("build-dir");
  if (explicit) return path.resolve(repoRoot, explicit);

  const candidates = readdirSync(buildRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildRoot, entry.name))
    .filter((dir) => /linux/i.test(path.basename(dir)))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (!candidates[0]) {
    throw new Error(
      `No Linux Electrobun build directory found under ${buildRoot}`,
    );
  }

  return candidates[0];
}

function findExecutable(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (!entry.isFile()) continue;
    const mode = statSync(fullPath).mode;
    if ((mode & 0o111) !== 0 && !/\.(so|dylib|dll)$/i.test(entry.name)) {
      return fullPath;
    }
  }

  const queue = [root];
  const ignored = new Set(["node_modules", "Resources", "locales"]);
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      const mode = statSync(fullPath).mode;
      if ((mode & 0o111) !== 0 && !/\.(so|dylib|dll)$/i.test(entry.name)) {
        return fullPath;
      }
    }
  }
  throw new Error(`Could not find executable under ${root}`);
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
      "Categories=Utility;Network;",
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
    dereference: true,
  });

  const executable = findExecutable(path.join(destRoot, optDir));
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
}

async function buildDeb(buildDir) {
  const root = path.join(os.tmpdir(), `${namespace}-deb-${process.pid}`);
  return withStagingCleanup(root, async () => {
    await stagePackageRoot(buildDir, root);
    const controlDir = path.join(root, "DEBIAN");
    mkdirSync(controlDir, { recursive: true, mode: 0o755 });
    writeFileSync(
      path.join(controlDir, "control"),
      [
        `Package: ${packageName}`,
        `Version: ${version.replace(/-/g, "~")}`,
        "Section: utils",
        "Priority: optional",
        `Architecture: ${debArch}`,
        "Maintainer: elizaOS <hello@elizaos.ai>",
        `Description: ${displayName} desktop app`,
        ` The consumer ${displayName} app for desktop chat, account setup, and connected devices.`,
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
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
    await stagePackageRoot(buildDir, appDir);
    copyFileSync(
      path.join(appDir, `usr/share/applications/${namespace}.desktop`),
      path.join(appDir, `${namespace}.desktop`),
    );
    if (existsSync(iconPath))
      copyFileSync(iconPath, path.join(appDir, `${namespace}.png`));
    writeFileSync(
      path.join(appDir, "AppRun"),
      `#!/usr/bin/env sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/${namespace}" "$@"\n`,
      { mode: 0o755 },
    );

    const tool = path.join(os.tmpdir(), "appimagetool-x86_64.AppImage");
    if (!existsSync(tool)) {
      sh("curl", [
        "-fsSL",
        "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage",
        "-o",
        tool,
      ]);
      sh("chmod", ["+x", tool]);
    }
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
