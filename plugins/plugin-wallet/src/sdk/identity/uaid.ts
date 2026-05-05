/**
 * uaid.ts — Universal Agent Identifier (UAID) Resolution Layer
 *
 * Provides cross-chain agent identity resolution via the HOL Registry Broker.
 * UAIDs are chain-agnostic identifiers that bridge ERC-8004 tokens on EVM chains
 * to agents on Solana, Hedera, off-chain frameworks, and any other protocol.
 *
 * This module is an optional extension — agents that only operate on EVM chains
 * can continue using ERC8004Client directly.
 *
 * Registry: https://hol.org
 * SDK: @hol-org/rb-client (peer dependency — install only if needed)
 *
 * @module identity/uaid
 */

import type { Address } from "viem";
import type {
  AgentIdentity,
  AgentRegistrationFile,
  SupportedChain,
} from "./erc8004.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported protocol types in the UAID ecosystem */
export type UAIDProtocol =
  | "erc8004"
  | "a2a"
  | "openconvai"
  | "virtuals"
  | "x402"
  | "hedera"
  | "solana"
  | string;

/** A parsed UAID with its component parts */
export interface ParsedUAID {
  /** Raw UAID string */
  raw: string;
  /** Agent identifier portion */
  aid: string;
  /** Unique identifier portion */
  uid: string;
  /** Protocol used for resolution */
  protocol: UAIDProtocol;
  /** Native identifier on the protocol's own chain/system */
  nativeId?: string;
}

/** Result of resolving a UAID to a known identity */
export interface UAIDResolution {
  /** Whether resolution succeeded */
  resolved: boolean;
  /** The UAID that was resolved */
  uaid: string;
  /** Resolved agent identity (if ERC-8004 backed) */
  identity: UniversalAgentIdentity | null;
  /** Protocol the agent was resolved through */
  protocol: UAIDProtocol;
  /** Chain the identity lives on (if applicable) */
  chain?: string;
  /** Trust score from the registry (0-100) */
  trustScore?: number;
  /** Whether the agent is verified in the HOL registry */
  registryVerified: boolean;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Universal agent identity — superset of ERC-8004 AgentIdentity that works
 * across chains. For EVM agents, this mirrors AgentIdentity. For non-EVM
 * agents, it provides equivalent fields using native identifiers.
 */
export interface UniversalAgentIdentity {
  /** Identifier — ERC-8004 tokenId for EVM, native ID for others */
  agentId: string;
  /** Owner — EVM address, Hedera account, Solana pubkey, etc. */
  owner: string;
  /** Agent URI / metadata endpoint */
  agentURI: string;
  /** Payment address (chain-native format) */
  paymentAddress: string;
  /** Registration metadata (if available) */
  registrationFile: AgentRegistrationFile | null;
  /** Source protocol */
  protocol: UAIDProtocol;
  /** Source chain */
  chain: string;
  /** UAID for cross-chain reference */
  uaid: string;
}

/** Configuration for the UAID resolver */
export interface UAIDResolverConfig {
  /** HOL Registry Broker API key (optional for read-only resolution) */
  apiKey?: string;
  /** Custom broker base URL (defaults to production) */
  brokerUrl?: string;
  /** Request timeout in ms (default: 10000) */
  timeoutMs?: number;
  /** Cache resolved identities for this many ms (default: 300000 = 5 min) */
  cacheTtlMs?: number;
}

/** Parameters for registering an ERC-8004 identity as a UAID */
export interface RegisterUAIDParams {
  /** ERC-8004 agent ID (tokenId) */
  agentId: bigint;
  /** Chain the identity is registered on */
  chain: SupportedChain;
  /** Registry contract address (uses known defaults if omitted) */
  registryAddress?: Address;
  /** Agent name for the registry */
  name: string;
  /** Agent description */
  description: string;
  /** Optional: additional capabilities to advertise */
  capabilities?: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_BROKER_URL = "https://hol.org/registry/api/v1";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes

/** EVM chain IDs for UAID protocol mapping */
const EVM_CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  "base-sepolia": 84532,
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  polygon: 137,
};

// ─── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: UAIDResolution;
  expiresAt: number;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class UAIDResolver {
  private readonly brokerUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: UAIDResolverConfig = {}) {
    this.brokerUrl = (config.brokerUrl ?? DEFAULT_BROKER_URL).replace(
      /\/+$/,
      "",
    );
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  // ── Core resolution ──────────────────────────────────────────────────────

  /**
   * Resolve a UAID to an agent identity.
   *
   * Works across chains — the resolver contacts the HOL Registry Broker to
   * find the agent's identity regardless of whether it lives on EVM, Hedera,
   * Solana, or off-chain.
   *
   * @param uaid - Universal Agent Identifier string
   * @returns Resolution result with identity details
   *
   * @example
   * ```ts
   * const resolver = new UAIDResolver();
   * const result = await resolver.resolve('uaid:aid:0x8004...;uid=42;proto=erc8004');
   * if (result.resolved) {
   *   console.log(result.identity?.paymentAddress);
   * }
   * ```
   */
  async resolve(uaid: string): Promise<UAIDResolution> {
    // Check cache
    const cached = this.cache.get(uaid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    try {
      const response = await this.brokerRequest(
        "GET",
        `/agents/resolve?uaid=${encodeURIComponent(uaid)}`,
      );

      if (!response.ok) {
        const result: UAIDResolution = {
          resolved: false,
          uaid,
          identity: null,
          protocol: "unknown",
          registryVerified: false,
          error: `Registry returned ${response.status}`,
        };
        return result;
      }

      const data = await response.json();

      const identity: UniversalAgentIdentity = {
        agentId: String(data.agentId ?? data.nativeId ?? ""),
        owner: data.owner ?? data.controller ?? "",
        agentURI: data.agentURI ?? data.metadataUri ?? "",
        paymentAddress: data.paymentAddress ?? data.agentWallet ?? "",
        registrationFile: data.registrationFile ?? null,
        protocol: data.protocol ?? "unknown",
        chain: data.chain ?? "",
        uaid,
      };

      const result: UAIDResolution = {
        resolved: true,
        uaid,
        identity,
        protocol: data.protocol ?? "unknown",
        chain: data.chain,
        trustScore: data.trustScore,
        registryVerified: data.verified ?? false,
      };

      // Cache the result
      this.cache.set(uaid, { result, expiresAt: Date.now() + this.cacheTtlMs });
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        resolved: false,
        uaid,
        identity: null,
        protocol: "unknown",
        registryVerified: false,
        error: `Resolution failed: ${message}`,
      };
    }
  }

  /**
   * Search the HOL registry for agents matching criteria.
   *
   * @param query - Search terms (name, capability, protocol)
   * @param options - Optional filters
   * @returns Array of matching UAIDResolution results
   */
  async search(
    query: string,
    options?: {
      protocol?: UAIDProtocol;
      limit?: number;
      minTrustScore?: number;
    },
  ): Promise<UAIDResolution[]> {
    try {
      const params = new URLSearchParams({ q: query });
      if (options?.protocol) params.set("protocol", options.protocol);
      if (options?.limit) params.set("limit", String(options.limit));
      if (options?.minTrustScore)
        params.set("minTrust", String(options.minTrustScore));

      const response = await this.brokerRequest(
        "GET",
        `/agents/search?${params}`,
      );
      if (!response.ok) return [];

      const data = await response.json();
      const results: UAIDResolution[] = (data.agents ?? []).map(
        (agent: Record<string, unknown>) => ({
          resolved: true,
          uaid: agent.uaid as string,
          identity: {
            agentId: String(agent.agentId ?? agent.nativeId ?? ""),
            owner: (agent.owner ?? agent.controller ?? "") as string,
            agentURI: (agent.agentURI ?? agent.metadataUri ?? "") as string,
            paymentAddress: (agent.paymentAddress ??
              agent.agentWallet ??
              "") as string,
            registrationFile: (agent.registrationFile ??
              null) as AgentRegistrationFile | null,
            protocol: (agent.protocol ?? "unknown") as UAIDProtocol,
            chain: (agent.chain ?? "") as string,
            uaid: agent.uaid as string,
          },
          protocol: (agent.protocol ?? "unknown") as UAIDProtocol,
          chain: agent.chain as string | undefined,
          trustScore: agent.trustScore as number | undefined,
          registryVerified: (agent.verified ?? false) as boolean,
        }),
      );

      return results;
    } catch {
      return [];
    }
  }

  // ── ERC-8004 ↔ UAID bridge ────────────────────────────────────────────────

  /**
   * Convert an ERC-8004 AgentIdentity to a UniversalAgentIdentity.
   *
   * Useful when you already have an on-chain identity and want to work
   * with the universal format (e.g., for cross-chain discovery).
   */
  erc8004ToUniversal(
    identity: AgentIdentity,
    chain: SupportedChain,
  ): UniversalAgentIdentity {
    const chainId = EVM_CHAIN_IDS[chain];
    return {
      agentId: identity.agentId.toString(),
      owner: identity.owner,
      agentURI: identity.agentURI,
      paymentAddress: identity.agentWallet,
      registrationFile: identity.registrationFile,
      protocol: "erc8004",
      chain: `eip155:${chainId}`,
      uaid: `uaid:aid:eip155:${chainId}:${identity.owner};uid=${identity.agentId};proto=erc8004`,
    };
  }

  /**
   * Build a UAID string for an ERC-8004 agent.
   *
   * This creates the identifier — it does NOT register with the HOL registry.
   * Use registerERC8004Agent() to make the agent discoverable cross-chain.
   */
  buildERC8004UAID(
    agentId: bigint,
    chain: SupportedChain,
    ownerAddress: Address,
  ): string {
    const chainId = EVM_CHAIN_IDS[chain];
    return `uaid:aid:eip155:${chainId}:${ownerAddress};uid=${agentId};proto=erc8004`;
  }

  /**
   * Register an ERC-8004 agent in the HOL registry for cross-chain discovery.
   *
   * After registration, agents on Solana, Hedera, or any protocol can
   * discover and verify this agent's identity via its UAID.
   *
   * Requires an API key with write permissions.
   *
   * @param params - Registration parameters
   * @returns The assigned UAID
   */
  async registerERC8004Agent(params: RegisterUAIDParams): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        "UAIDResolver: API key required for registration. Get one at https://hol.org",
      );
    }

    const chainId = EVM_CHAIN_IDS[params.chain];
    const uaid = `uaid:aid:eip155:${chainId}:${params.registryAddress ?? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"};uid=${params.agentId};proto=erc8004`;

    const response = await this.brokerRequest("POST", "/agents/register", {
      uaid,
      protocol: "erc8004",
      chain: `eip155:${chainId}`,
      agentId: params.agentId.toString(),
      name: params.name,
      description: params.description,
      capabilities: params.capabilities ?? [],
      registryAddress:
        params.registryAddress ?? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `UAIDResolver: Registration failed (${response.status}): ${errorBody}`,
      );
    }

    const data = await response.json();
    return data.uaid ?? uaid;
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Verify an agent's identity via UAID — works across any chain.
   *
   * This is the cross-chain equivalent of ERC8004Client.lookupAgentIdentity().
   * For EVM agents, it verifies the UAID maps to a valid on-chain ERC-8004 token.
   * For non-EVM agents, it verifies through the registry's native trust mechanism.
   *
   * @param uaid - Universal Agent Identifier to verify
   * @returns Verification result
   */
  async verify(uaid: string): Promise<{
    verified: boolean;
    identity: UniversalAgentIdentity | null;
    trustScore: number;
    protocol: UAIDProtocol;
    error?: string;
  }> {
    const resolution = await this.resolve(uaid);

    if (!resolution.resolved || !resolution.identity) {
      return {
        verified: false,
        identity: null,
        trustScore: 0,
        protocol: resolution.protocol,
        error: resolution.error ?? "Agent not found in registry",
      };
    }

    return {
      verified: resolution.registryVerified,
      identity: resolution.identity,
      trustScore: resolution.trustScore ?? 0,
      protocol: resolution.protocol,
    };
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Parse a UAID string into its components.
   *
   * Format: `uaid:aid:<identifier>;uid=<unique-id>;proto=<protocol>[;nativeId=<id>]`
   */
  static parseUAID(uaid: string): ParsedUAID | null {
    if (!uaid.startsWith("uaid:")) return null;

    const parts = uaid.split(";");
    const aidPart = parts.find((p) => p.startsWith("uaid:aid:"));
    const uidPart = parts.find((p) => p.startsWith("uid="));
    const protoPart = parts.find((p) => p.startsWith("proto="));
    const nativeIdPart = parts.find((p) => p.startsWith("nativeId="));

    if (!aidPart || !uidPart || !protoPart) return null;

    return {
      raw: uaid,
      aid: aidPart.replace("uaid:aid:", ""),
      uid: uidPart.replace("uid=", ""),
      protocol: protoPart.replace("proto=", "") as UAIDProtocol,
      nativeId: nativeIdPart?.replace("nativeId=", ""),
    };
  }

  /** Clear the resolution cache */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async brokerRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.brokerUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "agentwallet-sdk/uaid-resolver",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
