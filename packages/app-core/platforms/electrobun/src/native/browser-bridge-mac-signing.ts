/** Resolves one concrete Apple signing prefix for Safari and desktop sharing. */

import fs from "node:fs";
import path from "node:path";

export const MAC_BROWSER_BRIDGE_KEYCHAIN_GROUP_SUFFIX =
  "ai.elizaos.browserbridge.shared";

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

export function browserBridgeKeychainAccessGroup(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(
      "Apple Team ID must be exactly 10 uppercase letters or digits",
    );
  }
  return `${teamId}.${MAC_BROWSER_BRIDGE_KEYCHAIN_GROUP_SUFFIX}`;
}

export function resolvePackagedBrowserBridgeAccessGroup(
  moduleDir: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = fs.existsSync,
  readFile: (candidate: string) => string = (candidate) =>
    fs.readFileSync(candidate, "utf8"),
): string | null {
  const environmentTeamId = resolveAppleTeamId(env);
  if (environmentTeamId)
    return browserBridgeKeychainAccessGroup(environmentTeamId);
  const candidates = [
    path.resolve(moduleDir, "..", "browser-bridge-signing.json"),
    path.resolve(moduleDir, "..", "..", "build", "browser-bridge-signing.json"),
  ];
  const metadataPath = candidates.find(exists);
  if (!metadataPath) return null;
  const parsed = JSON.parse(readFile(metadataPath)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("browser bridge signing metadata is invalid");
  }
  const teamId = (parsed as Record<string, unknown>).teamId;
  if (typeof teamId !== "string") {
    throw new Error("browser bridge signing metadata has no Team ID");
  }
  return browserBridgeKeychainAccessGroup(teamId);
}
