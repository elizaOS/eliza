/**
 * Generate ES256 (ECDSA P-256) JWT signing key pair for JWT_SIGNING_PRIVATE_KEY and JWT_SIGNING_PUBLIC_KEY.
 * Outputs base64-encoded PEM suitable for .env (same format as lib/auth/jwks.ts expects).
 *
 * Note: Uses console.log intentionally as this is a CLI script meant for human output.
 */
import { generateJwtSigningKeys } from "./local-dev-helpers";

const keys = generateJwtSigningKeys();

console.log("# Add these to your .env (ES256 PKCS#8 / SPKI, base64-encoded PEM)\n");
console.log(`JWT_SIGNING_PRIVATE_KEY=${keys.JWT_SIGNING_PRIVATE_KEY}`);
console.log(`JWT_SIGNING_PUBLIC_KEY=${keys.JWT_SIGNING_PUBLIC_KEY}`);
