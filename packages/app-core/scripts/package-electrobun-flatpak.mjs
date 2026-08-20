#!/usr/bin/env node
/**
 * Packages the already-built Linux Electrobun application tree as a
 * side-loadable Flatpak, preserving the exact desktop runtime tested by the
 * canonical release lane instead of substituting the command-line package.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

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
export const FLATPAK_FINISH_ARGS = [
  "--command=eliza",
  "--share=network",
  "--share=ipc",
  "--socket=wayland",
  "--socket=fallback-x11",
  "--socket=pulseaudio",
  "--device=dri",
];
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

export async function writeMetadata(filesDir, relativeLauncher) {
  mkdirSync(path.join(filesDir, "bin"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/applications"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/metainfo"), { recursive: true });
  mkdirSync(path.join(filesDir, "share/icons/hicolor/512x512/apps"), {
    recursive: true,
  });

  const wrapper = path.join(filesDir, "bin/eliza");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env sh\nexec /app/opt/eliza/${relativeLauncher} "$@"\n`,
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

async function main() {
  if (process.platform !== "linux") {
    throw new Error(
      `Flatpak packaging requires Linux, got ${process.platform}`,
    );
  }
  if (!existsSync(iconPath)) throw new Error(`Missing app icon: ${iconPath}`);

  const buildDir = latestLinuxBuildDir();
  const relativeLauncher = requireLauncher(buildDir);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "eliza-flatpak-"));
  const appDir = path.join(tempRoot, "app");
  const repoDir = path.join(tempRoot, "repo");
  const output = path.join(
    artifactRoot,
    `Eliza-${version}-linux-${arch}.flatpak`,
  );

  try {
    run("flatpak", [
      "build-init",
      "--type=app",
      `--arch=${arch}`,
      appDir,
      APP_ID,
      FLATPAK_RUNTIME.sdk,
      FLATPAK_RUNTIME.platform,
      FLATPAK_RUNTIME.version,
    ]);
    await cp(buildDir, path.join(appDir, "files/opt/eliza"), {
      recursive: true,
      force: true,
      dereference: true,
    });
    await writeMetadata(path.join(appDir, "files"), relativeLauncher);
    run("flatpak", ["build-finish", ...FLATPAK_FINISH_ARGS, appDir]);
    run("flatpak", [
      "build-export",
      `--arch=${arch}`,
      repoDir,
      appDir,
      "stable",
    ]);
    mkdirSync(artifactRoot, { recursive: true });
    run("flatpak", [
      "build-bundle",
      `--arch=${arch}`,
      repoDir,
      output,
      APP_ID,
      "stable",
    ]);
    console.log(`Wrote ${path.relative(repoRoot, output)}`);
  } finally {
    run(process.execPath, [cleanupHelper, tempRoot]);
  }
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
