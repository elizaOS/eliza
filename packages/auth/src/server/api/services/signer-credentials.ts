import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SIGNER_CREDENTIAL_VERSION = "stwd_scrypt_v1";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 32;

function signerCredentialPepper(): string {
  const pepper = process.env.STEWARD_SIGNER_CREDENTIAL_PEPPER;
  if (pepper && pepper.trim().length >= 32) return pepper;
  if (pepper) {
    throw new Error(
      "STEWARD_SIGNER_CREDENTIAL_PEPPER must contain at least 32 characters of entropy. " +
        "Generate with `openssl rand -hex 32`.",
    );
  }
  // SEC-073: never silently degrade to an unpeppered hash — mirror the
  // STEWARD_AUDIT_HMAC_KEY posture (services/audit.ts). The pepper is
  // defense-in-depth against a DB-only attacker (scrypt+salt still applies),
  // but losing it must be loud, not silent. Production fails closed; outside
  // production the pepperless path requires the explicit dev opt-in.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "STEWARD_SIGNER_CREDENTIAL_PEPPER is required in production. " +
        "Generate with `openssl rand -hex 32`.",
    );
  }
  if (process.env.STEWARD_ALLOW_DEV_SECRETS !== "true") {
    throw new Error(
      "STEWARD_SIGNER_CREDENTIAL_PEPPER is required. For local development only, set " +
        "STEWARD_ALLOW_DEV_SECRETS=true to run without a pepper.",
    );
  }
  return "";
}

function signerCredentialInput(secret: string): string {
  return `${secret}:${signerCredentialPepper()}`;
}

export async function createSignerCredentialHash(
  secret: string,
): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(
    signerCredentialInput(secret),
    salt,
    SCRYPT_KEY_LENGTH,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    },
  );
  return [
    SIGNER_CREDENTIAL_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt,
    key.toString("hex"),
  ].join("$");
}

export async function verifySignerCredential(
  secret: string,
  storedHash: string,
): Promise<boolean> {
  const [
    version,
    costText,
    blockSizeText,
    parallelizationText,
    salt,
    expectedText,
  ] = storedHash.split("$");
  if (version !== SIGNER_CREDENTIAL_VERSION || !salt || !expectedText)
    return false;

  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (
    cost !== SCRYPT_COST ||
    blockSize !== SCRYPT_BLOCK_SIZE ||
    parallelization !== SCRYPT_PARALLELIZATION
  ) {
    return false;
  }

  if (!/^[0-9a-f]+$/i.test(expectedText)) return false;
  const expected = Buffer.from(expectedText, "hex");
  if (expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = scryptSync(
    signerCredentialInput(secret),
    salt,
    SCRYPT_KEY_LENGTH,
    {
      N: cost,
      r: blockSize,
      p: parallelization,
    },
  );
  return timingSafeEqual(actual, expected);
}
