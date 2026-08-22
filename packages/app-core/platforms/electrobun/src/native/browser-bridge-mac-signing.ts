/** Validates the provisioning identity required for desktop and Safari App Group sharing. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MAC_BROWSER_BRIDGE_APP_GROUP } from "./browser-bridge-broker-transport";

export interface BrowserBridgeMacProvisioningContract {
  teamId: string;
  appId: string;
  applicationIdentifier: string;
  appGroup: typeof MAC_BROWSER_BRIDGE_APP_GROUP;
  profileUuid: string;
}

interface MacAuthorityCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function resolveAppleTeamId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = [
    env.ELIZA_APPLE_TEAM_ID,
    env.ELECTROBUN_TEAMID,
    env.ELIZA_SAFARI_SIGNING_TEAM,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(configured)];
  if (unique.length > 1) {
    throw new Error("Safari and desktop Apple Team IDs do not match");
  }
  if (unique.length === 0) return null;
  if (!/^[A-Z0-9]{10}$/.test(unique[0])) {
    throw new Error(
      "Apple Team ID must be exactly 10 uppercase letters or digits",
    );
  }
  return unique[0];
}

export function validateBrowserBridgeMacProvisioningProfile(
  profile: unknown,
  expected: { teamId: string; appId: string; channel: "direct" | "store" },
): BrowserBridgeMacProvisioningContract {
  if (!profile || typeof profile !== "object") {
    throw new Error("browser bridge provisioning profile is invalid");
  }
  const record = profile as Record<string, unknown>;
  const entitlements = record.Entitlements as
    | Record<string, unknown>
    | undefined;
  const teams = record.TeamIdentifier;
  const uuid = record.UUID;
  const expirationMs = Date.parse(String(record.ExpirationDate ?? ""));
  const applicationIdentifier = entitlements?.["application-identifier"];
  const groups = entitlements?.["com.apple.security.application-groups"];
  if (
    !Array.isArray(teams) ||
    teams.length !== 1 ||
    teams[0] !== expected.teamId ||
    typeof uuid !== "string" ||
    typeof applicationIdentifier !== "string" ||
    applicationIdentifier !== `${expected.teamId}.${expected.appId}` ||
    !Array.isArray(groups) ||
    !groups.includes(MAC_BROWSER_BRIDGE_APP_GROUP) ||
    !Number.isFinite(expirationMs) ||
    expirationMs <= Date.now() ||
    (expected.channel === "direct" && record.ProvisionsAllDevices !== true) ||
    (expected.channel === "store" && record.ProvisionsAllDevices === true)
  ) {
    throw new Error(
      "browser bridge provisioning profile does not authorize the exact app identity and App Group",
    );
  }
  return {
    teamId: expected.teamId,
    appId: expected.appId,
    applicationIdentifier,
    appGroup: MAC_BROWSER_BRIDGE_APP_GROUP,
    profileUuid: uuid,
  };
}

export function resolvePackagedBrowserBridgeAppGroup(
  moduleDir: string,
  exists: (candidate: string) => boolean = fs.existsSync,
  readFile: (candidate: string) => string = (candidate) =>
    fs.readFileSync(candidate, "utf8"),
): typeof MAC_BROWSER_BRIDGE_APP_GROUP | null {
  const candidates = [
    path.resolve(moduleDir, "..", "browser-bridge-signing.json"),
    path.resolve(moduleDir, "..", "..", "build", "browser-bridge-signing.json"),
  ];
  const metadataPath = candidates.find(exists);
  if (!metadataPath) return null;
  const parsed = JSON.parse(
    readFile(metadataPath),
  ) as Partial<BrowserBridgeMacProvisioningContract>;
  if (
    !/^[A-Z0-9]{10}$/.test(parsed.teamId ?? "") ||
    typeof parsed.appId !== "string" ||
    parsed.applicationIdentifier !== `${parsed.teamId}.${parsed.appId}` ||
    parsed.appGroup !== MAC_BROWSER_BRIDGE_APP_GROUP ||
    typeof parsed.profileUuid !== "string" ||
    parsed.profileUuid.length === 0
  ) {
    throw new Error("browser bridge packaged provisioning metadata is invalid");
  }
  return MAC_BROWSER_BRIDGE_APP_GROUP;
}

export function verifyRunningBrowserBridgeMacAuthority(
  moduleDir: string,
  appBundlePath: string | null,
  options: {
    exists?: (candidate: string) => boolean;
    readFile?: (candidate: string) => string;
    run?: (command: string, args: string[]) => MacAuthorityCommandResult;
  } = {},
): typeof MAC_BROWSER_BRIDGE_APP_GROUP | null {
  const exists = options.exists ?? fs.existsSync;
  const readFile =
    options.readFile ?? ((candidate) => fs.readFileSync(candidate, "utf8"));
  const appGroup = resolvePackagedBrowserBridgeAppGroup(
    moduleDir,
    exists,
    readFile,
  );
  if (!appGroup) return null;
  if (
    !appBundlePath ||
    !path.isAbsolute(appBundlePath) ||
    !appBundlePath.endsWith(".app")
  ) {
    throw new Error(
      "browser bridge runtime App Group authority requires an app bundle",
    );
  }
  const metadataCandidates = [
    path.resolve(moduleDir, "..", "browser-bridge-signing.json"),
    path.resolve(moduleDir, "..", "..", "build", "browser-bridge-signing.json"),
  ];
  const metadataPath = metadataCandidates.find(exists);
  if (!metadataPath) {
    throw new Error("browser bridge packaged provisioning metadata is missing");
  }
  const metadata = JSON.parse(
    readFile(metadataPath),
  ) as BrowserBridgeMacProvisioningContract;
  const embeddedProfile = path.join(
    appBundlePath,
    "Contents",
    "embedded.provisionprofile",
  );
  if (!exists(embeddedProfile)) {
    throw new Error("browser bridge runtime provisioning profile is missing");
  }
  const run =
    options.run ??
    ((command, args) => {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 5_000,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });
  const verification = run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    appBundlePath,
  ]);
  const signature = run("/usr/bin/codesign", [
    "-dvv",
    "--entitlements",
    ":-",
    appBundlePath,
  ]);
  const profile = run("/usr/bin/security", [
    "cms",
    "-D",
    "-i",
    embeddedProfile,
  ]);
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  const profileText = `${profile.stdout}\n${profile.stderr}`;
  if (
    verification.status !== 0 ||
    signature.status !== 0 ||
    profile.status !== 0 ||
    !signatureText.includes(`Identifier=${metadata.appId}`) ||
    !signatureText.includes(`TeamIdentifier=${metadata.teamId}`) ||
    !signatureText.includes(metadata.applicationIdentifier) ||
    !signatureText.includes(MAC_BROWSER_BRIDGE_APP_GROUP) ||
    !profileText.includes(`<string>${metadata.profileUuid}</string>`) ||
    !profileText.includes(
      `<string>${metadata.applicationIdentifier}</string>`,
    ) ||
    !profileText.includes(`<string>${MAC_BROWSER_BRIDGE_APP_GROUP}</string>`)
  ) {
    throw new Error(
      "browser bridge running code does not match packaged App Group authority",
    );
  }
  return appGroup;
}
