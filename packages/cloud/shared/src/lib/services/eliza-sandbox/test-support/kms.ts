/** Creates genuine KMS decryption failures for snapshot policy tests using the in-memory key backend. Callers explicitly trigger key resets; importing this module does not install test hooks or mocks. */

import { decryptField, encryptField } from "../../../../db/crypto/field-crypto";
import { resetKmsClientForTests } from "../../../../db/crypto/kms-client";

// Drive the real core KMS stack so the errors the snapshot-degrade
// path classifies are genuine (`AeadError`, `KeyNotFoundError`) — not hand-rolled
// stand-ins. In NODE_ENV=test, getKmsClient() resolves the in-process memory
// backend, which is exactly what orphans keys across a restart in prod.
export const KMS_TEST_ORG = "org-test-1";

export const KMS_TEST_COORDS = {
  table: "agent_sandbox_backups",
  rowId: "00000000-0000-4000-8000-0000000000aa",
  column: "state_data",
};

// A genuine AeadError: decrypt with the wrong AAD so the GCM auth tag fails to
// verify — the shape a corrupt / wrong-key snapshot surfaces as.
export async function realAeadDecryptError(): Promise<Error> {
  resetKmsClientForTests();
  const enc = await encryptField(KMS_TEST_ORG, '{"memories":[]}', KMS_TEST_COORDS);
  try {
    await decryptField(enc, { ...KMS_TEST_COORDS, rowId: "00000000-0000-4000-8000-0000000000bb" });
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected a real AeadError from the AAD mismatch");
}

// A genuine KeyNotFoundError, reproducing the HQ #14308 incident: encrypt under
// the memory backend, then "restart" it (resetKmsClientForTests → a fresh
// MemoryKmsAdapter with an empty key map) so the key that encrypted the field is
// gone, and decrypt of the older ciphertext can no longer find it.
export async function realKeyRotatedAwayError(): Promise<Error> {
  resetKmsClientForTests();
  const enc = await encryptField(KMS_TEST_ORG, '{"memories":[]}', KMS_TEST_COORDS);
  resetKmsClientForTests();
  try {
    await decryptField(enc, KMS_TEST_COORDS);
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected a real KeyNotFoundError after the key was rotated away");
}
