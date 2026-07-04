/**
 * Cloud-first product policy shared by the app shell and first-run setup.
 */
export { shouldUseCloudOnlyBranding } from "@elizaos/shared";

type EnvValue = string | boolean | undefined;

export interface LocalRemoteOnboardingEnv {
  PROD?: EnvValue;
  VITE_ELIZA_ENABLE_LOCAL_REMOTE_ONBOARDING?: EnvValue;
}

function isTruthyEnv(value: EnvValue): boolean {
  return value === true || String(value ?? "").trim() === "1";
}

function isExplicitlyDisabled(value: EnvValue): boolean {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function viteEnv(): LocalRemoteOnboardingEnv {
  return (
    (import.meta as ImportMeta & { env?: LocalRemoteOnboardingEnv }).env ?? {}
  );
}

/**
 * Local and remote first-run paths stay available for development and explicit
 * test builds, while production defaults to the cloud-only onboarding product.
 */
export function canOfferLocalRemoteOnboarding(
  env: LocalRemoteOnboardingEnv = viteEnv(),
): boolean {
  if (isExplicitlyDisabled(env.VITE_ELIZA_ENABLE_LOCAL_REMOTE_ONBOARDING)) {
    return false;
  }
  if (isTruthyEnv(env.VITE_ELIZA_ENABLE_LOCAL_REMOTE_ONBOARDING)) return true;
  return !isTruthyEnv(env.PROD);
}
