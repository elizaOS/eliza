/** Bounded failure detail for an explicitly selected local recipient; never public plaintext. */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sealToRecipient } from "./recipient-envelope";

const CODES = new Set([
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_USER_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TOO_MANY_REQUESTS",
  "RATE_LIMITED",
]);
export function prepareProviderErrorEnvelope(input: {
  recipientPublicKey: string;
  file: string;
  operationReceipt: string;
  knownPrivateValues: string[];
}) {
  if (
    input.recipientPublicKey.length > 16384 ||
    !/^[a-f0-9]{64}$/.test(input.operationReceipt)
  )
    throw Error("provider_evidence_configuration_invalid");
  try {
    sealToRecipient(Buffer.alloc(0), input.recipientPublicKey);
  } catch {
    throw Error("provider_evidence_recipient_invalid");
  }
  let receipt: {
    state: "not_observed" | "sealed" | "unavailable";
    ciphertextSha256: string | null;
  } = { state: "not_observed", ciphertextSha256: null };
  const sensitive = [
    ...new Set(
      input.knownPrivateValues
        .filter((v) => typeof v === "string" && v.length > 0)
        .flatMap((v) => [
          v,
          encodeURIComponent(v),
          JSON.stringify(v).slice(1, -1),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  return {
    receipt: () => ({ ...receipt }),
    capture(errors: unknown) {
      // One capture, no overwrite or plaintext fallback, including write/encryption failure.
      if (receipt.state !== "not_observed") return;
      receipt = { state: "unavailable", ciphertextSha256: null };
      let plaintext: Buffer | undefined;
      try {
        if (!Array.isArray(errors) || errors.length === 0 || errors.length > 16)
          return;
        const details = errors.map((error) => {
          if (
            !error ||
            typeof error !== "object" ||
            typeof error.message !== "string" ||
            error.message.length > 4096
          )
            throw Error("provider_evidence_shape");
          let message = error.message;
          for (const value of sensitive)
            message = message.split(value).join("[redacted]");
          message = message.replace(
            /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
            "[identifier]",
          );
          const code =
            typeof error.extensions?.code === "string" &&
            CODES.has(error.extensions.code)
              ? error.extensions.code
              : "UNKNOWN";
          return { code, message };
        });
        plaintext = Buffer.from(
          JSON.stringify({
            purpose: "backup_provider_failure",
            operationReceipt: input.operationReceipt,
            errors: details,
          }),
        );
        if (plaintext.length > 65536) return;
        const encoded = JSON.stringify(
          sealToRecipient(plaintext, input.recipientPublicKey),
        );
        writeFileSync(input.file, encoded, { flag: "wx", mode: 0o600 });
        receipt = {
          state: "sealed",
          ciphertextSha256: createHash("sha256").update(encoded).digest("hex"),
        };
      } catch {
        /* finite unavailable receipt only; never fall back to public plaintext */
      } finally {
        plaintext?.fill(0);
      }
    },
  };
}
