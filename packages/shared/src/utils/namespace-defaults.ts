/**
 * Resolves the app namespace default from `ELIZA_NAMESPACE`, so white-label
 * entrypoints (Milady, Eliza) consistently fall back to their own namespace
 * rather than a hardcoded one.
 */
type NamespaceDefaultsEnv = {
  ELIZA_NAMESPACE?: string;
};

function trimEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * App entrypoints should consistently default to the app namespace even
 * when they bypass the CLI/profile bootstrap path.
 */
export function ensureNamespaceDefaults(
  env: NamespaceDefaultsEnv | undefined = (
    globalThis as { process?: { env?: NamespaceDefaultsEnv } }
  ).process?.env,
): void {
  if (!env) return;

  if (!trimEnvValue(env.ELIZA_NAMESPACE)) {
    env.ELIZA_NAMESPACE = "eliza";
  }
}

ensureNamespaceDefaults();
