/**
 * Re-export shared onboarding presets for `@elizaos/agent/onboarding-presets`.
 *
 * The implementation lives in `@elizaos/shared` so agent does not fork character
 * preset tables. This file exists so the package export map resolves and lint can
 * scan a real module.
 */
export * from "@elizaos/shared/onboarding-presets";
