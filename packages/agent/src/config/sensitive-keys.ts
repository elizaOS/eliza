/**
 * Single classifier for config keys whose values must be treated as secrets.
 *
 * This is intentionally separate from BLOCKED_ENV_KEYS: blocked keys are
 * injection/persistence policy, while this predicate controls redaction and UI
 * sensitivity hints for arbitrary config paths.
 */
const SENSITIVE_CONFIG_KEY_RE =
  /password|passwd|passphrase|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|tokens?$|(?:^|[._-])pat$|(?:^|[._-])webhook[a-z]*$|(?:^|[._-])(?:dsn|url|uri|jwt|bearer|cookie|mnemonic)$|(?:^|[._-])key$/i;

/**
 * camelCase companions for the separator-anchored names above, so
 * `sessionKey`, `encryptionKey`, `webhookUrl`, `discordWebhook`, and
 * `accessJwt` classify the same as their SCREAMING_SNAKE forms.
 * Case-sensitive on purpose: all-lower and all-upper lookalikes (`monkey`,
 * `turnkey`, `hotkey`, `KEYBOARD`) must stay non-sensitive.
 */
const SENSITIVE_CAMEL_KEY_RE =
  /[a-z](?:Key|Url|Uri|Jwt|Bearer|Cookie|Mnemonic|Webhook)$/;

/**
 * Separator-free concatenated `*KEY` names (MASTERKEY, SIGNINGKEY, SSHKEY,
 * ENCRYPTIONKEY) have no word boundary for the rules above, and the camelCase
 * rule requires a lowercase predecessor — so a closed suffix set on the
 * normalized name catches them without opening `key$` to lookalikes
 * (`monkey`, `turnkey`, `KEYBOARD`). Lowercase `auth` is deliberately not a
 * generic secret key: the canonical config uses it for profile containers and
 * provider mode discriminators. An exact SCREAMING_SNAKE `AUTH` environment
 * key remains classified, while credential children inside structural auth
 * containers are redacted individually.
 */
const SENSITIVE_CONCAT_KEY_RE = /(?:master|signing|ssh|encryption)key$/i;

export function isSensitiveConfigKey(key: string): boolean {
  const lastSegment = key.split(".").at(-1) ?? key;
  const normalized = lastSegment.replace(/[-_\s]/g, "").toLowerCase();
  if (/^maxtokens?$/.test(normalized)) return false;
  return (
    SENSITIVE_CONFIG_KEY_RE.test(key) ||
    SENSITIVE_CAMEL_KEY_RE.test(lastSegment) ||
    SENSITIVE_CONCAT_KEY_RE.test(normalized) ||
    lastSegment === "AUTH"
  );
}
