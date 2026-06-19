/**
 * MCP registry DTO types (app-hosted Eliza Cloud surface).
 *
 * Mirrors the real cloud-api MCP registry contract:
 *   - `GET/POST  /api/v1/mcps`             (user-created MCP CRUD + list)
 *   - `GET/PUT/DELETE /api/v1/mcps/:mcpId` (detail / update / delete)
 *   - `POST/DELETE   /api/v1/mcps/:mcpId/publish` (publish / unpublish)
 *   - `GET /api/mcp/list`                  (built-in platform MCP catalog)
 *   - `GET /api/mcp/proxy/:mcpId`          (live user-MCP info / connection probe)
 *
 * The backend persists snake_case columns (`UserMcp` Drizzle row); these types
 * intentionally re-state that snake_case shape rather than inventing a camelCase
 * transport DTO, because the registry routes return the row verbatim
 * (`c.json({ mcp })`). Keeping the field names identical to the DB row is the
 * single source of truth — the UI reads exactly what the API returns.
 */

/** Pricing model for a monetizable user MCP. */
export type McpPricingType = "free" | "credits" | "x402";

/** Lifecycle status of a user MCP. `live` == published + discoverable. */
export type McpStatus =
  | "draft"
  | "pending_review"
  | "live"
  | "suspended"
  | "deprecated";

/** Where the MCP server actually runs. */
export type McpEndpointType = "container" | "external";

/** MCP wire transport. */
export type McpTransportType = "streamable-http" | "stdio";

/** Curated category for discovery/filtering (matches the create-route enum). */
export type McpCategory =
  | "utilities"
  | "finance"
  | "data"
  | "communication"
  | "productivity"
  | "ai"
  | "search"
  | "platform"
  | "other";

/** A single tool exposed by a user MCP. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** Display-only cost label, e.g. `"1 credit"` / `"$0.001"`. */
  cost?: string;
}

/**
 * A user-created MCP as returned by the v1 registry routes — the persisted
 * `UserMcp` row (snake_case), serialized over JSON (timestamps become ISO
 * strings / null).
 */
export interface UserMcpRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;

  organization_id: string;
  created_by_user_id: string;

  endpoint_type: McpEndpointType;
  container_id: string | null;
  external_endpoint: string | null;
  endpoint_path: string | null;

  transport_type: McpTransportType;
  mcp_version: string | null;

  tools: McpTool[];

  category: string;
  tags: string[];
  icon: string | null;
  color: string | null;

  pricing_type: McpPricingType;
  credits_per_request: string | null;
  x402_price_usd: string | null;
  x402_enabled: boolean;

  creator_share_percentage: string;
  platform_share_percentage: string;

  total_requests: number;
  total_credits_earned: string | null;
  total_x402_earned_usd: string | null;
  unique_users: number;

  status: McpStatus;
  is_public: boolean;
  is_featured: boolean;
  is_verified: boolean;

  documentation_url: string | null;
  source_code_url: string | null;
  support_email: string | null;

  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  published_at: string | null;

  /** Present on the detail (`GET /:mcpId`) response — resolved public URL. */
  endpointUrl?: string;
}

/** Owner-only usage stats returned by `GET /api/v1/mcps/:mcpId`. */
export interface McpStats {
  totalRequests: number;
  totalCreditsEarned: number;
  totalX402EarnedUsd: number;
  uniqueUsers: number;
}

/** Response shape of `GET /api/v1/mcps`. */
export interface ListUserMcpsResponse {
  mcps: UserMcpRecord[];
  total: number;
  scope: "own" | "public" | "all";
  filters: {
    category?: string;
    search?: string;
    status?: McpStatus;
  };
  pagination: { limit: number; offset: number };
}

/** Response shape of `GET /api/v1/mcps/:mcpId`. */
export interface UserMcpDetailResponse {
  mcp: UserMcpRecord;
  stats: McpStats | null;
  isOwner: boolean;
}

/** Response shape of `POST /api/v1/mcps`. */
export interface CreateUserMcpResponse {
  mcp: UserMcpRecord;
}

/** Response shape of `PUT /api/v1/mcps/:mcpId` and the publish/unpublish routes. */
export interface MutateUserMcpResponse {
  mcp: UserMcpRecord;
  message?: string;
}

/** Request body for `POST /api/v1/mcps` (matches the route's create schema). */
export interface CreateUserMcpInput {
  name: string;
  slug: string;
  description: string;
  category?: McpCategory;
  endpointType?: McpEndpointType;
  containerId?: string;
  externalEndpoint?: string;
  endpointPath?: string;
  transportType?: McpTransportType;
  tools?: McpTool[];
  pricingType?: McpPricingType;
  creditsPerRequest?: number;
  x402PriceUsd?: number;
  x402Enabled?: boolean;
  creatorSharePercentage?: number;
  documentationUrl?: string;
  sourceCodeUrl?: string;
  supportEmail?: string;
  tags?: string[];
  icon?: string;
  color?: string;
}

/** Request body for `PUT /api/v1/mcps/:mcpId` (matches the route's update schema). */
export interface UpdateUserMcpInput {
  name?: string;
  description?: string;
  version?: string;
  category?: McpCategory;
  endpointPath?: string;
  transportType?: McpTransportType;
  tools?: McpTool[];
  pricingType?: McpPricingType;
  creditsPerRequest?: number;
  x402PriceUsd?: number;
  x402Enabled?: boolean;
  creatorSharePercentage?: number;
  documentationUrl?: string | null;
  sourceCodeUrl?: string | null;
  supportEmail?: string | null;
  tags?: string[];
  icon?: string;
  color?: string;
  isPublic?: boolean;
}

/**
 * A built-in platform MCP definition from `GET /api/mcp/list`. These are the
 * first-party MCP servers (eliza-cloud-mcp, time, weather, crypto, …) — not
 * user-owned, so they have no CRUD; they are browse + connection-test only.
 */
export interface BuiltinMcpDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  endpoint: string;
  category: string;
  status: string;
  x402Enabled: boolean;
  pricing: {
    type: McpPricingType;
    description: string;
    creditsPerRequest?: number | string;
  };
  tools: Array<{
    name: string;
    description: string;
    cost?: string;
    parameters?: Record<string, unknown>;
  }>;
}

/** Response shape of `GET /api/mcp/list`. */
export interface BuiltinMcpListResponse {
  mcps: BuiltinMcpDefinition[];
  total: number;
  categories: string[];
}

/** Live-MCP info from `GET /api/mcp/proxy/:mcpId` (connection probe target). */
export interface McpProxyInfoResponse {
  id: string;
  name: string;
  description: string;
  tools: McpTool[];
  pricing: {
    type: McpPricingType;
    creditsPerRequest: string | null;
    x402PriceUsd: string | null;
    x402Enabled: boolean;
  };
  endpoint: string;
  transport: McpTransportType;
}
