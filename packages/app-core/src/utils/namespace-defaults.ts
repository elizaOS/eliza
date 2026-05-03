import process from "node:process";

function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * App entrypoints should consistently default to the app namespace even
 * when they bypass the CLI/profile bootstrap path.
 */
export function ensureNamespaceDefaults(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!trimEnvValue(env.ELIZA_NAMESPACE)) {
    env.ELIZA_NAMESPACE = "eliza";
  }
}

ensureNamespaceDefaults();
