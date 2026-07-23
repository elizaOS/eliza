/**
 * Mints and validates browser or authenticated-native agent pairing tokens
 * behind the Cloud route boundary.
 */
import {
  type AgentPairingToken,
  agentPairingTokensRepository,
} from "../../db/repositories/agent-pairing-tokens";
import { getAlternateDomainOrigins } from "./pairing-token-domains";

export interface PairingToken {
  userId: string;
  orgId: string;
  agentId: string;
  instanceUrl: string;
  expectedOrigin: string;
  expiresAt: number;
  createdAt: number;
}

export interface AuthenticatedNativePairingBinding {
  userId: string;
  orgId: string;
  agentId: string;
  expectedOrigin: string;
}

const TOKEN_EXPIRY_MS = 60_000; // 60 seconds

async function hashToken(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;

    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 0x03) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      encoded += alphabet[((b & 0x0f) << 2) | (c >> 6)];
    }
    if (i + 2 < bytes.length) {
      encoded += alphabet[c & 0x3f];
    }
  }

  return encoded;
}

function createPairingToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url.origin;
  } catch {
    // error-policy:J3 malformed external origin input fails closed.
    return null;
  }
}

function toPairingToken(row: AgentPairingToken): PairingToken {
  return {
    userId: row.user_id,
    orgId: row.organization_id,
    agentId: row.agent_id,
    instanceUrl: row.instance_url,
    expectedOrigin: row.expected_origin,
    expiresAt: row.expires_at.getTime(),
    createdAt: row.created_at.getTime(),
  };
}

class PairingTokenService {
  async generateToken(
    userId: string,
    orgId: string,
    agentId: string,
    instanceUrl: string,
  ): Promise<string> {
    const expectedOrigin = new URL(instanceUrl).origin;
    const token = createPairingToken();
    const now = Date.now();

    await agentPairingTokensRepository.create({
      token_hash: await hashToken(token),
      organization_id: orgId,
      user_id: userId,
      agent_id: agentId,
      instance_url: instanceUrl,
      expected_origin: expectedOrigin,
      expires_at: new Date(now + TOKEN_EXPIRY_MS),
    });

    return token;
  }

  async validateToken(token: string, expectedOrigin?: string | null): Promise<PairingToken | null> {
    if (!expectedOrigin) {
      return null;
    }

    const normalizedOrigin = normalizeHttpOrigin(expectedOrigin);
    if (!normalizedOrigin) {
      return null;
    }

    const tokenHash = await hashToken(token);

    // Try the exact origin first
    let row = await agentPairingTokensRepository.consumeValidToken(tokenHash, normalizedOrigin);

    // If no match, try each alternate domain in the same alias group. The
    // dashboard may rewrite the agent URL between any two aliased domains
    // (waifu.fun ↔ eliza.ai ↔ elizacloud.ai), and we cannot predict which
    // one is stored as `expected_origin` for a given token row.
    if (!row) {
      for (const alternateOrigin of getAlternateDomainOrigins(normalizedOrigin)) {
        row = await agentPairingTokensRepository.consumeValidToken(tokenHash, alternateOrigin);
        if (row) break;
      }
    }

    if (!row) {
      return null;
    }

    return toPairingToken(row);
  }

  /**
   * Validate the explicit native exchange. Unlike the browser relay, native
   * WebViews may omit Origin, so the Cloud bearer identity and the origin
   * carried by the authenticated mint response are part of the atomic claim.
   * This path intentionally uses the exact minted origin; browser-only domain
   * alias compatibility remains confined to validateToken().
   */
  async validateAuthenticatedNativeToken(
    token: string,
    binding: AuthenticatedNativePairingBinding,
  ): Promise<PairingToken | null> {
    const normalizedOrigin = normalizeHttpOrigin(binding.expectedOrigin);
    if (!normalizedOrigin) {
      return null;
    }

    const row = await agentPairingTokensRepository.consumeValidAuthenticatedToken(
      await hashToken(token),
      {
        userId: binding.userId,
        organizationId: binding.orgId,
        agentId: binding.agentId,
        expectedOrigin: normalizedOrigin,
      },
    );

    return row ? toPairingToken(row) : null;
  }
}

let instance: PairingTokenService | null = null;

export function getPairingTokenService(): PairingTokenService {
  if (!instance) {
    instance = new PairingTokenService();
  }
  return instance;
}
