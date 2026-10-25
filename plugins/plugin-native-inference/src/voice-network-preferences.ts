import fsp from "node:fs/promises";
import path from "node:path";
import { logger, resolveStateDir } from "@elizaos/core";
import {
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  type NetworkPolicyPreferences,
} from "./model-catalog/network-policy.js";

export function voiceNetworkPreferencesPath(): string {
  return path.join(
    resolveStateDir(process.env),
    "local-inference",
    "voice-update-prefs.json",
  );
}
export async function readVoiceNetworkPreferences(): Promise<NetworkPolicyPreferences> {
  try {
    const raw = await fsp.readFile(voiceNetworkPreferencesPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<NetworkPolicyPreferences>;
    return normalizeNetworkPreferences(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_NETWORK_POLICY_PREFERENCES;
    }
    logger.warn(
      { err },
      "[voice-models-routes] failed to read voice-update-prefs.json — using defaults",
    );
    return DEFAULT_NETWORK_POLICY_PREFERENCES;
  }
}
export function normalizeNetworkPreferences(
  candidate: Partial<NetworkPolicyPreferences> | null | undefined,
): NetworkPolicyPreferences {
  const def = DEFAULT_NETWORK_POLICY_PREFERENCES;
  if (!candidate || typeof candidate !== "object") return def;
  const quietHours = Array.isArray(candidate.quietHours)
    ? candidate.quietHours
        .filter(
          (
            q,
          ): q is {
            start: string;
            end: string;
          } =>
            !!q &&
            typeof q === "object" &&
            typeof (
              q as {
                start: unknown;
              }
            ).start === "string" &&
            typeof (
              q as {
                end: unknown;
              }
            ).end === "string",
        )
        .map((q) => ({ start: q.start, end: q.end }))
    : def.quietHours;
  return {
    autoUpdateOnWifi:
      typeof candidate.autoUpdateOnWifi === "boolean"
        ? candidate.autoUpdateOnWifi
        : def.autoUpdateOnWifi,
    autoUpdateOnCellular:
      typeof candidate.autoUpdateOnCellular === "boolean"
        ? candidate.autoUpdateOnCellular
        : def.autoUpdateOnCellular,
    autoUpdateOnMetered:
      typeof candidate.autoUpdateOnMetered === "boolean"
        ? candidate.autoUpdateOnMetered
        : def.autoUpdateOnMetered,
    quietHours,
  };
}
