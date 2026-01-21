/**
 * Agent Registry Type Definitions for @polyagent/agents
 *
 * Agent types for ERC-8004, Agent0, and A2A Protocol
 */

// Import and re-export AgentCapabilities from shared
import type { AgentCapabilities } from "@polyagent/shared";
export type { AgentCapabilities };

/**
 * Agent types supported by the registry
 */
export enum AgentType {
  /** User-controlled agents */
  USER_CONTROLLED = "USER_CONTROLLED",

  /** Internal NPC agents */
  NPC = "NPC",

  /** External agents from ElizaOS, MCP, Agent0, etc. */
  EXTERNAL = "EXTERNAL",
}

/**
 * Agent lifecycle status
 */
export enum AgentStatus {
  /** Registry entry created, runtime not yet initialized */
  REGISTERED = "REGISTERED",

  /** AgentRuntime instance created and cached */
  INITIALIZED = "INITIALIZED",

  /** Agent actively participating */
  ACTIVE = "ACTIVE",

  /** Temporarily paused */
  PAUSED = "PAUSED",

  /** Runtime destroyed */
  TERMINATED = "TERMINATED",
}

/**
 * Agent trust levels
 */
export enum TrustLevel {
  /** Unverified external agent */
  UNTRUSTED = 0,

  /** Basic verification complete */
  BASIC = 1,

  /** On-chain ERC-8004 registration verified */
  VERIFIED = 2,

  /** Agent0 SDK verified with reputation score */
  TRUSTED = 3,

  /** First-party NPC or admin-approved agent */
  SYSTEM = 4,
}

/**
 * A2A Agent Card for discovery
 */
export interface AgentCard {
  /** Agent card schema version */
  version: "1.0";

  /** Unique agent identifier */
  agentId: string;

  /** Human-readable name */
  name: string;

  /** Agent description */
  description: string;

  /** Communication endpoints */
  endpoints: {
    a2a?: string;
    mcp?: string;
    rpc?: string;
  };

  /** Capability declaration */
  capabilities: AgentCapabilities;

  /** Authentication requirements */
  authentication?: {
    required: boolean;
    methods: ("apiKey" | "oauth" | "wallet")[];
  };

  /** Usage limits and pricing */
  limits?: {
    rateLimit?: number;
    costPerAction?: number;
  };
}

/**
 * On-chain registration data (ERC-8004)
 */
export interface OnChainRegistration {
  /** ERC-8004 NFT token ID */
  tokenId: number;

  /** Registration transaction hash */
  txHash: string;

  /** Server wallet that registered */
  serverWallet: string;

  /** Reputation score (0-100) */
  reputationScore: number;

  /** Chain ID */
  chainId: number;

  /** Contract addresses */
  contracts: {
    identityRegistry: string;
    reputationSystem: string;
  };
}

/**
 * Agent0 SDK registration data
 */
export interface Agent0Registration {
  /** Agent0 token ID from registry */
  tokenId: string;

  /** IPFS CID for metadata */
  metadataCID: string;

  /** Subgraph-indexed agent data */
  subgraphData?: {
    owner: string;
    metadataURI: string;
    timestamp: number;
  };

  /** Discovery endpoint */
  discoveryEndpoint: string;
}

/**
 * Agent registration record
 */
export interface AgentRegistration {
  /** Unique agent identifier */
  agentId: string;

  /** Agent type classification */
  type: AgentType;

  /** Current lifecycle status */
  status: AgentStatus;

  /** Trust and verification level */
  trustLevel: TrustLevel;

  /** Reference to User record */
  userId: string | null;

  /** Display name */
  name: string;

  /** Agent system prompt/personality */
  systemPrompt: string;

  /** Declared capabilities */
  capabilities: AgentCapabilities;

  /** Discovery metadata */
  discoveryMetadata: AgentCard | null;

  /** On-chain registration info */
  onChainData: OnChainRegistration | null;

  /** Agent0 SDK registration info */
  agent0Data: Agent0Registration | null;

  /** Active runtime instance reference */
  runtimeInstanceId: string | null;

  /** Timestamps */
  registeredAt: Date;
  lastActiveAt: Date | null;
  terminatedAt: Date | null;
}

/**
 * Agent discovery filter
 */
export interface AgentDiscoveryFilter {
  /** Filter by agent types */
  types?: AgentType[];

  /** Filter by status */
  statuses?: AgentStatus[];

  /** Minimum trust level */
  minTrustLevel?: TrustLevel;

  /** Required capabilities */
  requiredCapabilities?: string[];

  /** Search by name/description */
  search?: string;

  /** Filter by OASF skills */
  requiredSkills?: string[];

  /** Filter by OASF domains */
  requiredDomains?: string[];

  /** Match mode: 'any' (OR) or 'all' (AND) */
  matchMode?: "any" | "all";

  /** Pagination */
  limit?: number;
  offset?: number;
}

/**
 * Runtime creation options
 */
export interface RuntimeCreationOptions {
  /** Agent registry entry */
  registration: AgentRegistration;

  /** Override model selection */
  modelOverride?: string;

  /** Additional plugins beyond defaults */
  additionalPlugins?: Array<import("@elizaos/core").Plugin>;

  /** Skip automatic enhancement */
  skipEnhancement?: boolean;
}

/**
 * External agent connection parameters
 */
export interface ExternalAgentConnectionParams {
  /** External agent identifier */
  externalId: string;

  /** Agent name */
  name: string;

  /** Agent description/system prompt */
  description: string;

  /** Communication endpoint */
  endpoint: string;

  /** Protocol type */
  protocol: "a2a" | "mcp" | "agent0" | "custom";

  /** Declared capabilities */
  capabilities: AgentCapabilities;

  /** Authentication credentials */
  authentication?: {
    type: "wallet" | "apiKey" | "oauth";
    credentials: string;
  };

  /** Agent Card metadata */
  agentCard?: AgentCard;

  /** User ID of the person registering the agent */
  registeredByUserId?: string;
}
