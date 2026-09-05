const SENSITIVE_WEBHOOK_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "claimtoken",
  "claimtokenhash",
  "credentialsecret",
  "clientsecret",
  "idtoken",
  "jwt",
  "mnemonic",
  "password",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "seedphrase",
  "signersecret",
]);

const SENSITIVE_WEBHOOK_KEY_SUFFIXES = [
  "accesstoken",
  "apikey",
  "bearertoken",
  "claimtoken",
  "claimtokenhash",
  "clientsecret",
  "credentialsecret",
  "idtoken",
  "mnemonic",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seedphrase",
  "sessiontoken",
  "signersecret",
  "tokenhash",
];

function normalizeWebhookKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveWebhookKey(key: string): boolean {
  const normalized = normalizeWebhookKey(key);
  return (
    SENSITIVE_WEBHOOK_KEYS.has(normalized) ||
    SENSITIVE_WEBHOOK_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function redactWebhookSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactWebhookSecrets(item)) as T;
  }
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    redacted[key] = isSensitiveWebhookKey(key)
      ? "[REDACTED]"
      : redactWebhookSecrets(nestedValue);
  }
  return redacted as T;
}
