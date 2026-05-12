/**
 * Distribution profile — the storefront a build is targeting.
 *
 * `store` builds are submitted to the App Store / Play Store / Mac App Store /
 * MS Store and must respect their sandboxing rules. `unrestricted` is the
 * default for direct downloads and developer machines.
 *
 * Read by the capability broker so a single env flag can flip the runtime
 * into store-safe mode without touching the runtime execution mode (which
 * tracks where inference happens, not what privileges are allowed).
 */

export const DISTRIBUTION_PROFILES = ["store", "unrestricted"] as const;

export type DistributionProfile = (typeof DISTRIBUTION_PROFILES)[number];

const DISTRIBUTION_PROFILE_ENV_KEY = "ELIZA_DISTRIBUTION_PROFILE";

export function isDistributionProfile(
  value: unknown,
): value is DistributionProfile {
  return (
    typeof value === "string" &&
    DISTRIBUTION_PROFILES.includes(value as DistributionProfile)
  );
}

export function resolveDistributionProfile(
  env: NodeJS.ProcessEnv = process.env,
): DistributionProfile {
  const raw = env[DISTRIBUTION_PROFILE_ENV_KEY];
  if (typeof raw !== "string") return "unrestricted";
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "unrestricted";
  if (isDistributionProfile(trimmed)) return trimmed;
  throw new Error(
    `Invalid ${DISTRIBUTION_PROFILE_ENV_KEY}=${raw}. Expected one of: ${DISTRIBUTION_PROFILES.join(
      ", ",
    )}.`,
  );
}
