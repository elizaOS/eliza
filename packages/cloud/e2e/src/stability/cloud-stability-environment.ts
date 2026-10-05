/** Builds the credential-minimal environment admitted into the synthetic authority subprocess. */

export function authorityChildEnvironment(
  source: NodeJS.ProcessEnv,
  namespace: string,
  token: string,
): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH,
    TMPDIR: source.TMPDIR,
    LANG: source.LANG,
    TZ: source.TZ ?? "UTC",
    SYNTHETIC_CONTROL_NAMESPACE: namespace,
    SYNTHETIC_CONTROL_TOKEN: token,
  };
}
