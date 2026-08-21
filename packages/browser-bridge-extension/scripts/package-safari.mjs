#!/usr/bin/env bun
/**
 * Wraps dist/safari into a Safari Web Extension via xcrun, producing the
 * versioned app bundle for the Safari release. Source-project patching and its
 * archive are deterministic for fixed converter output; Xcode owns compiled app
 * serialization. The installed-browser smoke supplies an exact Apple
 * Development identity and team for a trusted local build.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  validateSafariSignedBundleContracts,
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
const execFileAsync = promisify(execFile);

async function readPlist(pathname) {
  const { stdout } = await execFileAsync(
    "plutil",
    ["-convert", "json", "-o", "-", pathname],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function readCodeSignatureEntitlements(bundlePath, temporaryPath) {
  const { stdout } = await execFileAsync(
    "codesign",
    ["-d", "--entitlements", ":-", bundlePath],
    { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 },
  );
  await fs.writeFile(temporaryPath, stdout);
  return readPlist(temporaryPath);
}

async function readEmbeddedProvisioningProfile(profilePath, temporaryPath) {
  await execFileAsync(
    "security",
    ["cms", "-D", "-i", profilePath, "-o", temporaryPath],
    {
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return readPlist(temporaryPath);
}

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
if (nativeConfiguration.release) {
  const extensionBundlePath = await findFileWithExtension(
    path.join(builtAppPath, "Contents", "PlugIns"),
    ".appex",
  );
  if (!extensionBundlePath) {
    throw new Error("Signed Safari app is missing its extension bundle.");
  }
  const verificationDirectory = path.join(
    distDir,
    "safari-signing-verification",
  );
  await run("node", [cleanupHelper, verificationDirectory], {
    cwd: extensionRoot,
  });
  await fs.mkdir(verificationDirectory, { recursive: true });
  const appEntitlements = await readCodeSignatureEntitlements(
    builtAppPath,
    path.join(verificationDirectory, "app-entitlements.plist"),
  );
  const extensionEntitlements = await readCodeSignatureEntitlements(
    extensionBundlePath,
    path.join(verificationDirectory, "extension-entitlements.plist"),
  );
  const appProfile = await readEmbeddedProvisioningProfile(
    path.join(builtAppPath, "Contents", "embedded.provisionprofile"),
    path.join(verificationDirectory, "app-profile.plist"),
  );
  const extensionProfile = await readEmbeddedProvisioningProfile(
    path.join(extensionBundlePath, "Contents", "embedded.provisionprofile"),
    path.join(verificationDirectory, "extension-profile.plist"),
  );
  validateSafariSignedBundleContracts({
    configuration: nativeConfiguration,
    appEntitlements,
    extensionEntitlements,
    appProfile,
    extensionProfile,
    bundleIdentifier,
  });
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
