export function createLiveRuntimeChildEnv(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

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
