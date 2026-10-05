/** Test-only browser credential handoff for the opt-in real Cloud Playwright lane. */

import { resolveCloudLiveOriginContract } from "./cloud-live-origin";

export const CLOUD_LIVE_STEWARD_TOKEN_KEY = "steward_session_token";
export const CLOUD_LIVE_STEWARD_TOKEN_SCOPE_KEY = "steward_session_token_scope";

type CloudLiveAuthEnv = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "ELIZA_UI_SMOKE_CLOUD_LIVE"
    | "ELIZAOS_CLOUD_API_KEY"
    | "ELIZAOS_CLOUD_BASE_URL"
    | "ELIZA_UI_SMOKE_CLOUD_EXPECTED_ENV"
  >
>;

type BrowserAuthSeed = {
  storageKey: string;
  token: string;
  scopeStorageKey: string;
  scope: string;
};

export type CloudLiveInitScriptTarget = {
  addInitScript(
    script: (seed: BrowserAuthSeed) => void,
    seed: BrowserAuthSeed,
  ): Promise<void>;
};

export function resolveCloudLiveBrowserAuthSeed(
  env: CloudLiveAuthEnv,
): BrowserAuthSeed | null {
  if (env.ELIZA_UI_SMOKE_CLOUD_LIVE !== "1") {
    return null;
  }

  const token = env.ELIZAOS_CLOUD_API_KEY?.trim();
  if (!token) return null;
  const origin = resolveCloudLiveOriginContract(env);
  if (!origin.ok) throw new Error(origin.reason);
  return {
    storageKey: CLOUD_LIVE_STEWARD_TOKEN_KEY,
    token,
    scopeStorageKey: CLOUD_LIVE_STEWARD_TOKEN_SCOPE_KEY,
    scope:
      origin.environment === "custom"
        ? `origin:${origin.origin}`
        : `eliza-cloud:${origin.environment}`,
  };
}

/**
 * Seed the workflow bearer into the browser's canonical Cloud auth store.
 *
 * The live runtime receives the key through its child environment, but the UI
 * intentionally cannot read server process env. Real onboarding provisions
 * from the browser and therefore needs the same bearer in the Steward store.
 * This helper is used only by the explicit Cloud-live spec and is inert in
 * every keyless/default lane.
 */
export async function seedCloudLiveBrowserAuth(
  target: CloudLiveInitScriptTarget,
  env: CloudLiveAuthEnv = process.env,
): Promise<boolean> {
  const seed = resolveCloudLiveBrowserAuthSeed(env);
  if (!seed) {
    return false;
  }

  await target.addInitScript(
    ({ storageKey, token, scopeStorageKey, scope }) => {
      localStorage.setItem(storageKey, token);
      // Loopback storage spans Cloud environments; pair the test credential
      // with its validated target just as the canonical login writer does.
      localStorage.setItem(scopeStorageKey, scope);
    },
    seed,
  );
  return true;
}
