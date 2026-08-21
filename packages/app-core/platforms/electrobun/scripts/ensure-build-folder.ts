/** Supports Electrobun packaging and signing workflow for app-core desktop builds. */
import fs from "node:fs";
import path from "node:path";
import { resolveChromeExtensionIdentity } from "../../../../browser-bridge-extension/scripts/chrome-identity.mjs";
import {
  resolveAppleTeamId,
  validateBrowserBridgeMacProvisioningProfile,
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
  chromeDevManifestKey: string;
  chromeDevExtensionId: string;
  firefoxExtensionId: string;
  safariExtensionId: string;
};
const chromeIdentity = resolveChromeExtensionIdentity({
  identity: extensionIdentity,
  release:
    envName !== "dev" ||
    process.env.ELIZA_BROWSER_BRIDGE_RELEASE_PACKAGING === "1",
  env: process.env,
});
fs.writeFileSync(
  path.join("build", "browser-bridge-release.json"),
  `${JSON.stringify({
    chromeExtensionId: chromeIdentity.extensionId,
    chromeIdentityAuthority: chromeIdentity.authority,
    firefoxExtensionId: extensionIdentity.firefoxExtensionId,
    safariExtensionId: extensionIdentity.safariExtensionId,
  })}\n`,
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
  const profilePath = process.env.ELIZA_BROWSER_BRIDGE_MAC_PROFILE?.trim();
  if (
    !profilePath ||
    !path.isAbsolute(profilePath) ||
    !fs.existsSync(profilePath)
  ) {
    throw new Error(
      "A browser-bridge provisioning profile is required for signed macOS packaging",
    );
  }
  const decoded = Bun.spawnSync(["security", "cms", "-D", "-i", profilePath]);
  if (decoded.exitCode !== 0) {
    throw new Error("Failed to decode browser-bridge provisioning profile");
  }
  const json = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", "-"], {
    stdin: decoded.stdout,
  });
  if (json.exitCode !== 0) {
    throw new Error("Failed to parse browser-bridge provisioning profile");
  }
  const appId = process.env.ELIZA_APP_ID?.trim() || "ai.elizaos.app";
  const contract = validateBrowserBridgeMacProvisioningProfile(
    JSON.parse(json.stdout.toString("utf8")),
    {
      teamId: appleTeamId,
      appId,
      channel: process.env.ELIZA_BUILD_VARIANT === "store" ? "store" : "direct",
    },
  );
  fs.copyFileSync(
    profilePath,
    path.join("build", "browser-bridge.provisionprofile"),
  );
  fs.writeFileSync(
    signingMetadataPath,
    `${JSON.stringify({ ...contract, appId })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
} else {
  fs.rmSync(signingMetadataPath, { force: true });
  fs.rmSync(path.join("build", "browser-bridge.provisionprofile"), {
    force: true,
  });
}
