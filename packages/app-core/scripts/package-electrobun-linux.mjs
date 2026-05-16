#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const electrobunRoot = path.join(
  repoRoot,
  "packages/app-core/platforms/electrobun",
);
const buildRoot = path.join(electrobunRoot, "build");
const artifactRoot = path.join(electrobunRoot, "artifacts");
const iconPath = path.join(electrobunRoot, "assets/appIcon.png");

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

function sh(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });
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

function writeDesktopFile(dest, execName = "eliza") {
  writeFileSync(
    dest,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Eliza",
      "Comment=Your Eliza, everywhere.",
      `Exec=${execName}`,
      "Icon=eliza",
      "Terminal=false",
      "Categories=Utility;Network;",
      "",
    ].join("\n"),
  );
}

async function stagePackageRoot(buildDir, destRoot) {
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(path.join(destRoot, "opt/eliza"), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/bin"), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/share/applications"), { recursive: true });
  mkdirSync(path.join(destRoot, "usr/share/icons/hicolor/512x512/apps"), {
    recursive: true,
  });

  await cp(buildDir, path.join(destRoot, "opt/eliza"), {
    recursive: true,
    force: true,
    dereference: true,
  });

  const executable = findExecutable(path.join(destRoot, "opt/eliza"));
  const relativeExecutable = path.relative(
    path.join(destRoot, "opt/eliza"),
    executable,
  );
  writeFileSync(
    path.join(destRoot, "usr/bin/eliza"),
    `#!/usr/bin/env sh\nexec /opt/eliza/${relativeExecutable} "$@"\n`,
    { mode: 0o755 },
  );
  writeDesktopFile(path.join(destRoot, "usr/share/applications/eliza.desktop"));
  if (existsSync(iconPath)) {
    copyFileSync(
      iconPath,
      path.join(destRoot, "usr/share/icons/hicolor/512x512/apps/eliza.png"),
    );
  }
}

async function buildDeb(buildDir) {
  const root = path.join(os.tmpdir(), `eliza-deb-${process.pid}`);
  await stagePackageRoot(buildDir, root);
  const controlDir = path.join(root, "DEBIAN");
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(
    path.join(controlDir, "control"),
    [
      "Package: elizaos-app",
      `Version: ${version.replace(/-/g, "~")}`,
      "Section: utils",
      "Priority: optional",
      `Architecture: ${debArch}`,
      "Maintainer: elizaOS <hello@elizaos.ai>",
      "Description: Eliza desktop app",
      " The consumer Eliza app for desktop chat, account setup, and connected devices.",
      "",
    ].join("\n"),
  );
  const out = path.join(artifactRoot, `elizaos-app_${version}_${debArch}.deb`);
  sh("dpkg-deb", ["--build", root, out]);
  rmSync(root, { recursive: true, force: true });
  return out;
}

async function buildRpm(buildDir) {
  const top = path.join(os.tmpdir(), `eliza-rpm-${process.pid}`);
  const buildroot = path.join(top, "BUILDROOT/elizaos-app");
  await stagePackageRoot(buildDir, buildroot);
  for (const dir of ["BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    mkdirSync(path.join(top, dir), { recursive: true });
  }
  const rpmVersion = version.replace(/-.*/, "");
  const rpmRelease = version.includes("-")
    ? version.replace(/^[^-]+-/, "").replace(/[^A-Za-z0-9.]/g, ".")
    : "1";
  const spec = path.join(top, "SPECS/elizaos-app.spec");
  writeFileSync(
    spec,
    [
      "Name: elizaos-app",
      `Version: ${rpmVersion}`,
      `Release: ${rpmRelease}%{?dist}`,
      "Summary: Eliza desktop app",
      "License: MIT",
      "BuildArch: " + rpmArch,
      "",
      "%description",
      "The consumer Eliza app for desktop chat, account setup, and connected devices.",
      "",
      "%install",
      "mkdir -p %{buildroot}",
      `cp -a ${buildroot}/* %{buildroot}/`,
      "",
      "%files",
      "/opt/eliza",
      "/usr/bin/eliza",
      "/usr/share/applications/eliza.desktop",
      "/usr/share/icons/hicolor/512x512/apps/eliza.png",
      "",
    ].join("\n"),
  );
  sh("rpmbuild", ["--define", `_topdir ${top}`, "-bb", spec]);
  const rpmDir = path.join(top, "RPMS", rpmArch);
  const rpm = readdirSync(rpmDir).find((name) => name.endsWith(".rpm"));
  if (!rpm) throw new Error("rpmbuild did not produce an rpm");
  const out = path.join(artifactRoot, `elizaos-app-${version}.${rpmArch}.rpm`);
  copyFileSync(path.join(rpmDir, rpm), out);
  rmSync(top, { recursive: true, force: true });
  return out;
}

async function buildAppImage(buildDir) {
  const appDir = path.join(os.tmpdir(), `Eliza.AppDir-${process.pid}`);
  await stagePackageRoot(buildDir, appDir);
  copyFileSync(
    path.join(appDir, "usr/share/applications/eliza.desktop"),
    path.join(appDir, "eliza.desktop"),
  );
  if (existsSync(iconPath))
    copyFileSync(iconPath, path.join(appDir, "eliza.png"));
  writeFileSync(
    path.join(appDir, "AppRun"),
    '#!/usr/bin/env sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/eliza" "$@"\n',
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
    `Eliza-${version}-linux-${arch}.AppImage`,
  );
  sh(tool, [appDir, out], {
    env: { ...process.env, ARCH: rpmArch, APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  rmSync(appDir, { recursive: true, force: true });
  return out;
}

mkdirSync(artifactRoot, { recursive: true });
const buildDir = latestBuildDir();
console.log(`Packaging Linux Electrobun build: ${buildDir}`);
console.log(`Version: ${version}; channel: ${channel}; arch: ${arch}`);

const outputs = [];
outputs.push(await buildDeb(buildDir));
outputs.push(await buildRpm(buildDir));
outputs.push(await buildAppImage(buildDir));

for (const output of outputs) {
  console.log(`Wrote ${path.relative(repoRoot, output)}`);
}
