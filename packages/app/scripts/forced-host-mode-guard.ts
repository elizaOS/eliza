/**
 * Deploy-config guard for the forced host-mode escape hatches.
 * VITE_FORCE_APP_MODE (packages/ui cloud/app-mode) and VITE_FORCE_APEX_CONSOLE
 * (packages/ui cloud/shell/apex-host) deliberately short-circuit their
 * hostname checks so `vite dev` on localhost can exercise those surfaces at
 * all. Baked into a deployed bundle, either flag reroutes EVERY host —
 * including the elizacloud.ai apex — so the production/staging Pages builds
 * (cloud-cf-deploy.yml, both the eliza-cloud and eliza-app projects run
 * `build:web` in production mode) must fail loudly at build time when a deploy
 * config sets one, instead of silently shipping a hijacked apex.
 */

export const FORCED_HOST_MODE_FLAGS = Object.freeze([
  "VITE_FORCE_APP_MODE",
  "VITE_FORCE_APEX_CONSOLE",
]);

/**
 * Names of forced host-mode flags present (set to any non-blank value — a
 * deploy config must not contain them at all) in the given env record.
 * Feed it Vite's `loadEnv` output so `.env*` files are covered, not just
 * `process.env`.
 */
export function forbiddenForcedHostModeFlags(env = process.env) {
  return FORCED_HOST_MODE_FLAGS.filter((flag) => {
    const value = env[flag];
    return typeof value === "string" && value.trim() !== "";
  });
}
