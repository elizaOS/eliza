/** Supports Electrobun packaging and signing workflow for app-core desktop builds. */
import fs from "node:fs";
import path from "node:path";
import {
  browserBridgeKeychainAccessGroup,
  resolveAppleTeamId,
} from "../src/native/browser-bridge-mac-signing";

const platformNames: Record<string, string> = {
  darwin: "macos",
  linux: "linux",
  win32: "windows",
};

const archNames: Record<string, string> = {
  arm64: "arm64",
  x64: "x64",
};

const envName = process.env.ELECTROBUN_ENV?.trim() || "dev";
const osName =
  process.env.ELECTROBUN_OS?.trim() || platformNames[process.platform];
const archName = process.env.ELECTROBUN_ARCH?.trim() || archNames[process.arch];

if (!osName || !archName) {
  throw new Error(
    `Unsupported Electrobun build target: ${process.platform}/${process.arch}`,
  );
}

fs.mkdirSync(path.join("build", `${envName}-${osName}-${archName}`), {
  recursive: true,
});

const extensionIdentity = JSON.parse(
  fs.readFileSync("../../../browser-bridge-extension/identity.json", "utf8"),
) as {
  chromeExtensionId: string;
  firefoxExtensionId: string;
  safariExtensionId: string;
};
fs.writeFileSync(
  path.join("build", "browser-bridge-release.json"),
  `${JSON.stringify(extensionIdentity)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const nativeHostTargets: Record<string, Record<string, string>> = {
  macos: { arm64: "bun-darwin-arm64", x64: "bun-darwin-x64" },
  linux: { arm64: "bun-linux-arm64", x64: "bun-linux-x64" },
  windows: { x64: "bun-windows-x64" },
};
const nativeHostTarget = nativeHostTargets[osName]?.[archName];
if (!nativeHostTarget) {
  throw new Error(
    `Unsupported browser native-host target: ${osName}/${archName}`,
  );
}
const nativeHostOutput = path.join(
  "build",
  `browser-bridge-native-host${osName === "windows" ? ".exe" : ""}`,
);
const compile = Bun.spawnSync([
  process.execPath,
  "build",
  "--compile",
  "--minify",
  "--target",
  nativeHostTarget,
  "src/native/browser-bridge-native-host-main.ts",
  "--outfile",
  nativeHostOutput,
]);
if (compile.exitCode !== 0) {
  throw new Error(
    `Failed to compile browser native host: ${compile.stderr.toString("utf8")}`,
  );
}

const signingMetadataPath = path.join("build", "browser-bridge-signing.json");
const appleTeamId = resolveAppleTeamId(process.env);
if (osName === "macos" && appleTeamId) {
  const macTarget = `${archName === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
  const keychainHelper = Bun.spawnSync([
    "xcrun",
    "swiftc",
    "-O",
    "-target",
    macTarget,
    "-framework",
    "Security",
    "src/native/macos-browser-bridge-keychain-helper.swift",
    "-o",
    path.join("build", "browser-bridge-keychain-helper"),
  ]);
  if (keychainHelper.exitCode !== 0) {
    throw new Error(
      `Failed to compile shared-Keychain helper: ${keychainHelper.stderr.toString("utf8")}`,
    );
  }
  fs.writeFileSync(
    signingMetadataPath,
    `${JSON.stringify({
      teamId: appleTeamId,
      accessGroup: browserBridgeKeychainAccessGroup(appleTeamId),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
} else {
  fs.rmSync(signingMetadataPath, { force: true });
}
