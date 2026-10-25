export const PLAINTEXT_KEY_EXPORT_ACKNOWLEDGEMENT =
  "I understand this response contains plaintext private keys";

type EnvLike = Record<string, string | undefined>;

function isProductionLike(env: EnvLike): boolean {
  const stewardEnv = env.STEWARD_ENV?.trim().toLowerCase();
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  return (
    stewardEnv === "production" ||
    stewardEnv === "prod" ||
    nodeEnv === "production"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function plaintextKeyExportResponseGateError(
  body: unknown,
  env: EnvLike = process.env,
): string | null {
  if (!isProductionLike(env)) return null;

  if (env.STEWARD_ALLOW_PLAINTEXT_KEY_EXPORT_IN_PRODUCTION !== "true") {
    return "Plaintext private key export responses are disabled in production. Use an encrypted export flow or set STEWARD_ALLOW_PLAINTEXT_KEY_EXPORT_IN_PRODUCTION=true for an audited break-glass operation.";
  }

  if (
    !isRecord(body) ||
    body.plaintextExportAcknowledgement !== PLAINTEXT_KEY_EXPORT_ACKNOWLEDGEMENT
  ) {
    return `Plaintext private key export in production requires plaintextExportAcknowledgement="${PLAINTEXT_KEY_EXPORT_ACKNOWLEDGEMENT}" in the request body.`;
  }

  return null;
}
