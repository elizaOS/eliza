import { createPublicKey, verify as verifySignature } from "node:crypto";
import bs58 from "bs58";

export function verifySolanaMessageSignature(
  message: string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const publicKeyBytes = bs58.decode(publicKey);
    const signatureBytes = bs58.decode(signature);
    if (publicKeyBytes.length !== 32) return false;

    const keyObject = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(publicKeyBytes).toString("base64url"),
      },
      format: "jwk",
    });

    return verifySignature(
      null,
      Buffer.from(message, "utf8"),
      keyObject,
      signatureBytes,
    );
  } catch {
    return false;
  }
}

export function looksLikeAuthMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("wants you to sign in with your ethereum account") ||
    normalized.includes("sign-in with ethereum") ||
    normalized.includes("siwe") ||
    normalized.includes("permit(") ||
    normalized.includes("permit2")
  );
}
