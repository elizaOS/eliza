/**
 * Mints and validates browser or authenticated-native agent pairing tokens
 * behind the Cloud route boundary.
 */
import {
  type AgentPairingToken,
  agentPairingTokensRepository,
} from "../../db/repositories/agent-pairing-tokens";
import { bytesToBase64Url, sha256Hex } from "../crypto/worker";
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

export interface BrowserPairingBinding {
  agentId: string;
  expectedOrigin: string;
}

export type BrowserPairingClaim =
  | {
      status: "claimed";
      pairingToken: PairingToken;
      apiKey: string;
      agentName: string | null;
    }
  | { status: "invalid" }
  | { status: "sandbox-credential-unavailable" };

export interface AuthenticatedNativePairingBinding {
  userId: string;
  orgId: string;
  agentId: string;
  expectedOrigin: string;
}

export type AuthenticatedNativePairingClaim =
  | {
      status: "claimed";
      pairingToken: PairingToken;
      apiKey: string;
      agentName: string | null;
    }
  | { status: "invalid" }
  | { status: "sandbox-credential-unavailable" };

const TOKEN_EXPIRY_MS = 60_000; // 60 seconds

async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

function createPairingToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
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

    // If no match, try each alternate domain in the same environment-scoped
    // alias group. The dashboard may rewrite the agent URL between canonical
    // and compatibility hosts, and we cannot predict which one is stored as
    // `expected_origin` for a given token row.
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
   * Atomically claim a browser pairing token for the agent selected by the
   * public Worker hostname. Rebrand aliases may substitute only the origin;
   * every database attempt retains the same URL-bound agent identity.
   */
  async claimBrowserToken(
    token: string,
    binding: BrowserPairingBinding,
  ): Promise<BrowserPairingClaim> {
    const normalizedOrigin = normalizeHttpOrigin(binding.expectedOrigin);
    if (!normalizedOrigin) {
      return { status: "invalid" };
    }

    const tokenHash = await hashToken(token);
    const candidateOrigins = [normalizedOrigin, ...getAlternateDomainOrigins(normalizedOrigin)];

    for (const expectedOrigin of candidateOrigins) {
      const claim = await agentPairingTokensRepository.consumeValidBrowserToken(tokenHash, {
        agentId: binding.agentId,
        expectedOrigin,
      });
      if (claim.status === "invalid") continue;
      if (claim.status === "sandbox-credential-unavailable") return claim;

      return {
        status: "claimed",
        pairingToken: toPairingToken(claim.token),
        apiKey: claim.apiKey,
        agentName: claim.agentName,
      };
    }

    return { status: "invalid" };
  }

  /**
   * Claim the explicit native exchange. Unlike the browser relay, native
   * WebViews may omit Origin, so the Cloud bearer identity and the origin
   * carried by the authenticated mint response are part of the atomic claim.
   * This path intentionally uses the exact minted origin; domain-alias
   * compatibility remains confined to the browser validation and claim paths.
   */
  async claimAuthenticatedNativeToken(
    token: string,
    binding: AuthenticatedNativePairingBinding,
  ): Promise<AuthenticatedNativePairingClaim> {
    const normalizedOrigin = normalizeHttpOrigin(binding.expectedOrigin);
    if (!normalizedOrigin) {
      return { status: "invalid" };
    }

    const claim = await agentPairingTokensRepository.consumeValidAuthenticatedToken(
      await hashToken(token),
      {
        userId: binding.userId,
        organizationId: binding.orgId,
        agentId: binding.agentId,
        expectedOrigin: normalizedOrigin,
      },
    );

    if (claim.status !== "claimed") return claim;

    return {
      status: "claimed",
      pairingToken: toPairingToken(claim.token),
      apiKey: claim.apiKey,
      agentName: claim.agentName,
    };
  }
}

let instance: PairingTokenService | null = null;

export function getPairingTokenService(): PairingTokenService {
  if (!instance) {
    instance = new PairingTokenService();
  }
  return instance;
}
