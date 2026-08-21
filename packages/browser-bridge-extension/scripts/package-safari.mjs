#!/usr/bin/env bun
/**
 * Wraps dist/safari into a Safari Web Extension via xcrun, producing the
 * versioned app bundle for the Safari release. Source-project patching and its
 * archive are deterministic for fixed converter output; Xcode owns compiled app
 * serialization. The installed-browser smoke supplies an exact Apple
 * Development identity and team for a trusted local build.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicDirectoryArchive } from "./package-webextension.mjs";
import {
  buildBrowserBridgeReleaseMetadata,
  buildSafariExtensionVersions,
  resolveBrowserBridgeReleaseVersion,
  versionedArtifactName,
} from "./release-version.mjs";
import {
  patchGeneratedSafariProject,
  resolveSafariNativeConfiguration,
} from "./safari-project.mjs";
import { findFileWithExtension, run } from "./script-utils.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const distDir = path.join(extensionRoot, "dist");
const safariDistDir = path.join(distDir, "safari");
const safariWorkDir = path.join(extensionRoot, "safari");
const generatedProjectDir = path.join(safariWorkDir, "generated");
const derivedDataDir = path.join(distDir, "safari-derived-data");
const artifactsDir = path.join(distDir, "artifacts");
const cleanupHelper = path.resolve(
  extensionRoot,
  "..",
  "scripts",
  "rm-path-recursive.mjs",
);
const appName = "Agent Browser Bridge";
const bundleIdentifier = "ai.elizaos.browserbridge.app";
const deploymentTarget = "14.0";
const release = resolveBrowserBridgeReleaseVersion();
const metadata = buildBrowserBridgeReleaseMetadata(release);
const safariVersions = buildSafariExtensionVersions(release);
const nativeConfiguration = resolveSafariNativeConfiguration();
const signingTeam = nativeConfiguration.signingTeam;
const signingIdentity = nativeConfiguration.signingIdentity;
const handlerTemplatePath = path.join(
  safariWorkDir,
  "native",
  "SafariWebExtensionHandler.swift",
);

await run("bun", [path.join(scriptDir, "build.mjs"), "safari"], {
  cwd: extensionRoot,
});

await fs.mkdir(safariWorkDir, { recursive: true });
await run("node", [cleanupHelper, generatedProjectDir, derivedDataDir], {
  cwd: extensionRoot,
});
await fs.mkdir(artifactsDir, { recursive: true });

await run("xcrun", [
  "safari-web-extension-converter",
  safariDistDir,
  "--project-location",
  generatedProjectDir,
  "--app-name",
  appName,
  "--bundle-identifier",
  bundleIdentifier,
  "--swift",
  "--macos-only",
  "--copy-resources",
  "--no-open",
  "--no-prompt",
  "--force",
]);

const projectPath = await findFileWithExtension(
  generatedProjectDir,
  ".xcodeproj",
);
if (!projectPath) {
  throw new Error("Failed to locate generated Safari Xcode project");
}
await patchGeneratedSafariProject({
  projectPath,
  appName,
  bundleIdentifier,
  marketingVersion: safariVersions.marketingVersion,
  buildVersion: safariVersions.buildVersion,
  deploymentTarget,
  configuration: nativeConfiguration,
  handlerTemplatePath,
});

const signingArgs =
  signingTeam && signingIdentity
    ? [
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGNING_REQUIRED=YES",
        "CODE_SIGN_STYLE=Manual",
        `CODE_SIGN_IDENTITY=${signingIdentity}`,
        `DEVELOPMENT_TEAM=${signingTeam}`,
      ]
    : [
        "CODE_SIGNING_ALLOWED=NO",
        "CODE_SIGNING_REQUIRED=NO",
        "CODE_SIGN_IDENTITY=",
      ];

await run("xcodebuild", [
  "-project",
  projectPath,
  "-scheme",
  appName,
  "-configuration",
  "Release",
  "-destination",
  "platform=macOS",
  "-derivedDataPath",
  derivedDataDir,
  ...signingArgs,
  "build",
]);

const builtAppPath = await findFileWithExtension(
  path.join(derivedDataDir, "Build", "Products"),
  ".app",
);
if (!builtAppPath) {
  throw new Error("Failed to locate built Safari app bundle");
}
if (signingTeam && signingIdentity) {
  await run("codesign", ["--verify", "--deep", "--strict", builtAppPath]);
}

const artifactAppPath = path.join(artifactsDir, `${appName}.app`);
const artifactZipPath = path.join(artifactsDir, "browser-bridge-safari.zip");
const versionedArtifactZipPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-safari", "zip", release),
);
const versionedProjectZipPath = path.join(
  artifactsDir,
  versionedArtifactName("browser-bridge-safari-project", "zip", release),
);
await run("node", [cleanupHelper, artifactAppPath], { cwd: extensionRoot });
await fs.rm(artifactZipPath, { force: true });
await fs.rm(versionedArtifactZipPath, { force: true });
await fs.rm(versionedProjectZipPath, { force: true });
await fs.cp(builtAppPath, artifactAppPath, { recursive: true });

await createDeterministicDirectoryArchive({
  sourceDir: artifactAppPath,
  outputPath: artifactZipPath,
  rootName: path.basename(artifactAppPath),
});
await fs.copyFile(artifactZipPath, versionedArtifactZipPath);
await createDeterministicDirectoryArchive({
  sourceDir: generatedProjectDir,
  outputPath: versionedProjectZipPath,
  rootName: path.basename(generatedProjectDir),
});

console.log(
  `Packaged Safari app ${metadata.releaseVersion} at ${artifactAppPath}`,
);
console.log(`Packaged Safari zip at ${artifactZipPath}`);
console.log(`Packaged Safari release zip at ${versionedArtifactZipPath}`);
console.log(`Packaged Safari project zip at ${versionedProjectZipPath}`);
