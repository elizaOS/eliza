/**
 * Captures the protected host profile from the process environment at entry.
 * Dependency-free so process entrypoints can capture it before configuration
 * or plugins load; admission and key-release rules live in protected-profile.
 */
import { ElizaError } from "@elizaos/core";

export const PROTECTED_PROFILE_ENV = "ELIZA_PROTECTED_PROFILE";
export const PROTECTED_PROFILES = ["dstack-cpu"] as const;
export type ProtectedProfile = (typeof PROTECTED_PROFILES)[number];

export type ProtectedProfileState = {
  profile: ProtectedProfile | undefined;
  environment: Readonly<Record<string, string | undefined>>;
};

let captured: ProtectedProfileState | undefined;

function selectProfile(
  value: string | undefined,
): ProtectedProfile | undefined {
  if (value === undefined || value === "") return undefined;
  if ((PROTECTED_PROFILES as readonly string[]).includes(value)) {
    return value as ProtectedProfile;
  }
  throw new ElizaError("Unknown protected profile", {
    code: "PROTECTED_PROFILE_UNKNOWN",
    context: { accepted: [...PROTECTED_PROFILES] },
  });
}

/**
 * Capture once, before configuration or plugins can mutate `process.env`.
 * Later calls return the first capture; an unknown profile value throws.
 */
export function captureProtectedProfile(): ProtectedProfileState {
  if (captured) return captured;
  const environment = Object.freeze({ ...process.env });
  captured = Object.freeze({
    profile: selectProfile(environment[PROTECTED_PROFILE_ENV]),
    environment,
  });
  return captured;
}

/** The selected protected profile, or undefined for ordinary hosts. */
export function getProtectedProfile(): ProtectedProfile | undefined {
  return captureProtectedProfile().profile;
}

export function isProtectedProfileSelected(): boolean {
  return getProtectedProfile() !== undefined;
}

/**
 * Environment used for TEE decisions: the frozen entry snapshot under the
 * protected profile, otherwise the live process environment.
 */
export function protectedTeeEnvironment(): Readonly<
  Record<string, string | undefined>
> {
  const state = captureProtectedProfile();
  return state.profile ? state.environment : process.env;
}
