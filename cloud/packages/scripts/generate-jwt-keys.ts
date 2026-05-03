/**
 * Generate ES256 (ECDSA P-256) JWT signing key pair for JWT_SIGNING_PRIVATE_KEY and JWT_SIGNING_PUBLIC_KEY.
 * Outputs base64-encoded PEM suitable for .env (same format as lib/auth/jwks.ts expects).
 *
 * Note: Uses console.log intentionally as this is a CLI script meant for human output.
 */
import crypto from "crypto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const privatePem = privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

const privateB64 = Buffer.from(privatePem, "utf8").toString("base64");
const publicB64 = Buffer.from(publicPem, "utf8").toString("base64");

console.log("# Add these to your .env (ES256 PKCS#8 / SPKI, base64-encoded PEM)\n");
console.log(`JWT_SIGNING_PRIVATE_KEY=${privateB64}`);
console.log(`JWT_SIGNING_PUBLIC_KEY=${publicB64}`);
