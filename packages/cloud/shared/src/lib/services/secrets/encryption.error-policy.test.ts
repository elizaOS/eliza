/**
 * Error-policy regression guard (#13415) for the secrets envelope: an internal
 * failure while unwrapping the DEK or verifying the ciphertext must PROPAGATE as
 * a typed DecryptionError — never be swallowed into an empty/partial plaintext a
 * caller would trust. Pairs each failure with the designed success so the two
 * are distinguishable. Real AES-256-GCM via LocalKMSProvider; the only stub is a
 * KMSProvider that throws, standing in for a KMS outage / rotated master key.
 */

import { describe, expect, test } from "bun:test";
import {
  DecryptionError,
  type KMSProvider,
  LocalKMSProvider,
  SecretsEncryptionService,
} from "./encryption";

const KEY = "b".repeat(64); // 32-byte hex master key

// KMS whose DEK unwrap always fails — models a rotated/lost SECRETS_MASTER_KEY
// or a KMS transport outage. generateDataKey succeeds so we can produce a
// well-formed envelope and then observe decrypt fail at the unwrap phase.
class FailingDecryptKMS implements KMSProvider {
  private inner = new LocalKMSProvider(KEY);
  generateDataKey() {
    return this.inner.generateDataKey();
  }
  async decrypt(): Promise<Buffer> {
    throw new Error("KMS unavailable");
  }
  isConfigured = () => true;
}

describe("#13415 — SecretsEncryptionService.decrypt fails observably, never silently", () => {
  test("designed success: a real round-trip returns the exact plaintext", async () => {
    const svc = new SecretsEncryptionService(new LocalKMSProvider(KEY));
    const enc = await svc.encrypt("real-access-token");
    const dec = await svc.decrypt(enc);
    // Distinguishes the healthy path from the failure paths below: a genuine
    // secret, not an empty/default string.
    expect(dec).toBe("real-access-token");
    expect(dec).not.toBe("");
  });

  test("DEK unwrap failure propagates as DecryptionError (not swallowed to empty)", async () => {
    const good = new SecretsEncryptionService(new LocalKMSProvider(KEY));
    const enc = await good.encrypt("real-access-token");

    const svc = new SecretsEncryptionService(new FailingDecryptKMS());
    // The J2 catch must rethrow with phase + cause, not return "" / default.
    const err = (await svc.decrypt(enc).catch((e) => e)) as DecryptionError;
    expect(err).toBeInstanceOf(DecryptionError);
    expect(err.phase).toBe("dek_decryption");
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe("KMS unavailable");
  });

  test("ciphertext tamper fails GCM verification as DecryptionError (value phase)", async () => {
    const svc = new SecretsEncryptionService(new LocalKMSProvider(KEY));
    const enc = await svc.encrypt("real-access-token");
    // Flip the auth tag: GCM verification must reject, and the J2 value-phase
    // catch must surface it rather than decode a partial/empty string.
    const tag = Buffer.from(enc.authTag, "base64");
    tag[0] ^= 0xff;
    const err = (await svc
      .decrypt({ ...enc, authTag: tag.toString("base64") })
      .catch((e) => e)) as DecryptionError;
    expect(err).toBeInstanceOf(DecryptionError);
    expect(err.phase).toBe("value_decryption");
    expect(err.cause).toBeInstanceOf(Error);
  });

  test("AAD mismatch is a failure, not a silent empty decrypt", async () => {
    const svc = new SecretsEncryptionService(new LocalKMSProvider(KEY));
    const enc = await svc.encrypt("scoped-secret", "vendor_connections|row-1|access_token");
    // Correct AAD -> designed plaintext; wrong AAD -> throws. The two outcomes
    // must be distinguishable, never both an empty string.
    expect(await svc.decrypt(enc, "vendor_connections|row-1|access_token")).toBe("scoped-secret");
    await expect(svc.decrypt(enc, "vendor_connections|row-2|access_token")).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });
});
