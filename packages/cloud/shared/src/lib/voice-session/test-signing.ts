/**
 * Shared test helper: generate an ES256 signing keypair and install it into the
 * env vars `auth/jwks` reads, so voice-session JWT mint/verify uses the REAL
 * signing path. Lives in the shared package (which declares `jose`) so the api
 * package tests can drive the same real path without depending on jose.
 */

import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

export async function installVoiceSessionTestSigningKey(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  process.env.JWT_SIGNING_PRIVATE_KEY = Buffer.from(await exportPKCS8(privateKey)).toString(
    "base64",
  );
  process.env.JWT_SIGNING_PUBLIC_KEY = Buffer.from(await exportSPKI(publicKey)).toString("base64");
  process.env.JWT_SIGNING_KEY_ID = "test-voice-key";
}
