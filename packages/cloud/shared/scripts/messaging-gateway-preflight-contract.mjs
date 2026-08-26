/**
 * Defines the complete WhatsApp credential authorities used by the gateway
 * preflight and resolves the smallest actionable missing-reference set.
 */

export const WHATSAPP_CREDENTIAL_SETS = [
  [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_VERIFY_TOKEN",
  ],
  [
    "ELIZA_APP_WHATSAPP_ACCESS_TOKEN",
    "ELIZA_APP_WHATSAPP_PHONE_NUMBER_ID",
    "ELIZA_APP_WHATSAPP_APP_SECRET",
    "ELIZA_APP_WHATSAPP_VERIFY_TOKEN",
  ],
];

export function missingWhatsAppCredentialRefs(env) {
  const [nearest, ...candidates] = WHATSAPP_CREDENTIAL_SETS.map((set) =>
    set.filter((name) => !env[name]?.trim()),
  );
  return candidates.reduce(
    (current, candidate) => (candidate.length < current.length ? candidate : current),
    nearest,
  );
}
