import { agentPairingTokensRepository } from "@/db/repositories/agent-pairing-tokens";

interface PairingToken {
  userId: string;
  orgId: string;
  agentId: string;
  instanceUrl: string;
  expectedOrigin: string;
  expiresAt: number;
  createdAt: number;
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

// Domain aliases — waifu.fun and eliza.ai resolve to the same containers.
// The dashboard rewrites URLs from one to the other, so the Origin header
// sent by pair.html may use either domain.
const DOMAIN_ALIASES: [string, string][] = [[".waifu.fun", ".eliza.ai"]];

class PairingTokenService {
  /**
   * Given an origin like https://uuid.waifu.fun, return https://uuid.eliza.ai
   * (and vice versa). Returns null if no alias applies.
   */
  private getAlternateDomainOrigin(origin: string): string | null {
    for (const [a, b] of DOMAIN_ALIASES) {
      try {
        const url = new URL(origin);
        if (url.hostname.endsWith(a)) {
          url.hostname = url.hostname.replace(new RegExp(`${a.replaceAll(".", "\\.")}$`), b);
          return url.origin;
        }
        if (url.hostname.endsWith(b)) {
          url.hostname = url.hostname.replace(new RegExp(`${b.replaceAll(".", "\\.")}$`), a);
          return url.origin;
        }
      } catch {
        // Invalid URL — skip
      }
    }
    return null;
  }

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

    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(expectedOrigin).origin;
    } catch {
      return null;
    }

    // Try the exact origin first
    let row = await agentPairingTokensRepository.consumeValidToken(
      await hashToken(token),
      normalizedOrigin,
    );

    // If no match, try the alternate domain. The dashboard may rewrite
    // waifu.fun → eliza.ai (or vice versa) which changes the Origin header
    // but both domains resolve to the same agent container.
    if (!row) {
      const alternateOrigin = this.getAlternateDomainOrigin(normalizedOrigin);
      if (alternateOrigin) {
        row = await agentPairingTokensRepository.consumeValidToken(
          await hashToken(token),
          alternateOrigin,
        );
      }
    }

    if (!row) {
      return null;
    }

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
}

let instance: PairingTokenService | null = null;

export function getPairingTokenService(): PairingTokenService {
  if (!instance) {
    instance = new PairingTokenService();
  }
  return instance;
}

export type { PairingToken };
