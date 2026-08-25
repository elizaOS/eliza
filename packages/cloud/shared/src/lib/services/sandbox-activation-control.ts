/** Owns activation-token custody without exposing an operational routing authority. */
import crypto from "node:crypto";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import { isValidUUID } from "../utils/validation";
import { type FieldCoords, fieldEncryption } from "./field-encryption";

const SHA256_RE = /^[0-9a-f]{64}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;

export type SandboxActivationTokenErrorCode =
  | "SANDBOX_ACTIVATION_IDENTITY_INVALID"
  | "SANDBOX_ACTIVATION_TOKEN_UNAVAILABLE"
  | "SANDBOX_ACTIVATION_TOKEN_INVALID";

export class SandboxActivationTokenError extends Error {
  constructor(
    public readonly code: SandboxActivationTokenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxActivationTokenError";
  }
}

function fail(code: SandboxActivationTokenErrorCode, message: string): never {
  throw new SandboxActivationTokenError(code, message);
}

function requireCanonicalUuid(value: string, field: string): void {
  if (typeof value !== "string" || !isValidUUID(value) || value !== value.toLowerCase()) {
    fail("SANDBOX_ACTIVATION_IDENTITY_INVALID", `${field} must be a canonical lowercase UUID`);
  }
}

function requireMasterKey(): void {
  if (!MASTER_KEY_RE.test(process.env.SECRETS_MASTER_KEY ?? "")) {
    fail(
      "SANDBOX_ACTIVATION_TOKEN_UNAVAILABLE",
      "Sandbox activation token encryption requires SECRETS_MASTER_KEY",
    );
  }
}

function tokenCoords(sandboxId: string): FieldCoords {
  return {
    table: "agent_sandboxes",
    rowId: sandboxId,
    column: "activation_token_ciphertext",
  };
}

export function hashSandboxActivationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function activationTokenHashMatches(token: string, expectedHash: string): boolean {
  if (!SHA256_RE.test(expectedHash)) return false;
  const actual = crypto.createHash("sha256").update(token).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && crypto.timingSafeEqual(actual, expected);
}

/** Mint and AAD-encrypt a fresh 256-bit token for one sandbox row. */
export async function createSandboxActivationToken(params: {
  sandboxId: string;
  organizationId: string;
}): Promise<Readonly<{ token: string; tokenHash: string; tokenCiphertext: string }>> {
  requireCanonicalUuid(params.sandboxId, "sandboxId");
  requireCanonicalUuid(params.organizationId, "organizationId");
  requireMasterKey();

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSandboxActivationToken(token);
  const tokenCiphertext = await fieldEncryption.encrypt(
    params.organizationId,
    token,
    tokenCoords(params.sandboxId),
  );
  if (typeof tokenCiphertext !== "string" || tokenCiphertext.length === 0) {
    fail("SANDBOX_ACTIVATION_TOKEN_INVALID", "Activation token encryption returned no ciphertext");
  }
  return Object.freeze({ token, tokenHash, tokenCiphertext });
}

/** Decrypt an AAD-bound token and prove it still matches the durable lowercase hash. */
export async function decryptSandboxActivationToken(
  sandbox: Readonly<
    Pick<AgentSandbox, "id" | "activation_token_ciphertext" | "activation_token_hash">
  >,
): Promise<string> {
  requireCanonicalUuid(sandbox.id, "sandbox.id");
  requireMasterKey();
  const tokenHash = sandbox.activation_token_hash;
  if (!sandbox.activation_token_ciphertext || !tokenHash || !SHA256_RE.test(tokenHash)) {
    fail(
      "SANDBOX_ACTIVATION_TOKEN_UNAVAILABLE",
      "Sandbox activation token is not durably available",
    );
  }

  const token = await fieldEncryption.decrypt(
    sandbox.activation_token_ciphertext,
    tokenCoords(sandbox.id),
  );
  if (!TOKEN_RE.test(token) || !activationTokenHashMatches(token, tokenHash)) {
    fail("SANDBOX_ACTIVATION_TOKEN_INVALID", "Sandbox activation token integrity check failed");
  }
  return token;
}
