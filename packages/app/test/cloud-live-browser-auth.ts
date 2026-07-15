/** Test-only browser credential handoff for the opt-in real Cloud Playwright lane. */

export const CLOUD_LIVE_STEWARD_TOKEN_KEY = "steward_session_token";

type CloudLiveAuthEnv = Partial<
  Pick<NodeJS.ProcessEnv, "ELIZA_UI_SMOKE_CLOUD_LIVE" | "ELIZAOS_CLOUD_API_KEY">
>;

type BrowserAuthSeed = {
  storageKey: string;
  token: string;
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
  return token ? { storageKey: CLOUD_LIVE_STEWARD_TOKEN_KEY, token } : null;
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

  await target.addInitScript(({ storageKey, token }) => {
    localStorage.setItem(storageKey, token);
  }, seed);
  return true;
}
