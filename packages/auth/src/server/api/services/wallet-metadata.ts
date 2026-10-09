const SECRET_METADATA_KEYS = new Set([
  "privatekey",
  "private_key",
  "secretkey",
  "secret_key",
  "mnemonic",
  "seed",
  "seedphrase",
  "seed_phrase",
  "wif",
  "xprv",
  "extendedprivatekey",
  "extended_private_key",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretMetadataKey(key: string): boolean {
  return SECRET_METADATA_KEYS.has(key.replace(/[-\s]/g, "").toLowerCase());
}

export function redactWalletMetadataSecrets(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSecretMetadataKey(key)) continue;
    if (Array.isArray(value)) {
      redacted[key] = value.map((item) =>
        isPlainObject(item) ? redactWalletMetadataSecrets(item) : item,
      );
      continue;
    }
    redacted[key] = isPlainObject(value)
      ? redactWalletMetadataSecrets(value)
      : value;
  }
  return redacted;
}
