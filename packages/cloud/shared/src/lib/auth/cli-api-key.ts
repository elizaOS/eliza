/** Recognizes CLI login credentials that require primary-consistent validation. */

export const CLI_API_KEY_PREFIX = "eliza_cli_";
const CLI_API_KEY_RE = /^eliza_cli_[0-9a-f]{64}$/;

export function isCliApiKeySecret(value: string): boolean {
  return CLI_API_KEY_RE.test(value);
}
