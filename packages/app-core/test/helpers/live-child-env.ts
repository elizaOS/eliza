import {
  buildIsolatedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
} from "./live-provider.ts";

export function createLiveRuntimeChildEnv(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const liveProviderOverrides = Object.fromEntries(
    Object.entries(overrides).filter(
      ([key, value]) => value !== undefined && LIVE_PROVIDER_ENV_KEYS.has(key),
    ),
  );
  const env: NodeJS.ProcessEnv =
    Object.keys(liveProviderOverrides).length > 0
      ? buildIsolatedLiveProviderEnv(process.env, {
          env: liveProviderOverrides as Record<string, string>,
        })
      : { ...process.env };

  for (const key of Object.keys(env)) {
    if (key === "VITEST" || key.startsWith("VITEST_")) {
      delete env[key];
    }
  }

  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
}
