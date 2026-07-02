/**
 * Organization DTO contract for the app-hosted Organization settings surface.
 *
 * These shapes mirror the canonical cloud-shared DTOs
 * (`@elizaos/cloud-shared/types` — `OrgMemberDto`, `OrgInviteDto`,
 * `OrganizationDto`, `UserWithOrganizationDto`) returned by:
 *
 * - `GET  /api/v1/user`                          → current user + organization
 * - `GET  /api/organizations/members`            → {@link OrgMemberDto}[]
 * - `GET  /api/organizations/invites`            → {@link OrgInviteDto}[]
 *
 * They are re-declared locally (not imported from `@elizaos/cloud-shared`)
 * because `@elizaos/ui` deliberately does not depend on the cloud-shared server
 * bundle. If the backend contract changes, update both — these are the exact
 * fields the route handlers serialize (see
 * `packages/cloud/api/organizations/**` and
 * `packages/cloud/shared/src/types/cloud-api.ts`).
 */

export interface OrgMemberDto {
  id: string;
  name: string | null;
  email: string | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgInviteDto {
  id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string;
  created_at: string;
  inviter: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  accepted_at: string | null;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  credit_balance: string;
  billing_email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserWithOrganizationDto {
  id: string;
  email: string | null;
  name: string | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  organization_id: string | null;
  role: string;
  organization: OrganizationDto | null;
}

/** `member` | `admin` — the two roles an invite can target (owner is implicit). */
export type InviteRole = "member" | "admin";

/**
 * POST /api/organizations/invites response payload. `token` is the raw invite
 * token, returned exactly once at creation so the inviter can copy a shareable
 * link (`/invite/accept?token=…`); only its hash is stored server-side.
 */
export interface CreatedInviteDto {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  status: string;
  token: string;
}

/**
 * Phase-1 direct-API providers a member can pool (#11332). Mirrors
 * `POOLED_DIRECT_PROVIDERS` in
 * `cloud/shared/src/lib/services/team-credential-pool/provider-map.ts`.
 * Subscription providers (Claude Max / ChatGPT) are Phase 2 and never
 * rendered here.
 */
export const POOLED_PROVIDERS = [
  "anthropic-api",
  "openai-api",
  "deepseek-api",
  "zai-api",
  "moonshot-api",
  "cerebras-api",
] as const;

export type PooledProviderId = (typeof POOLED_PROVIDERS)[number];

export const POOLED_PROVIDER_LABELS: Record<PooledProviderId, string> = {
  "anthropic-api": "Anthropic",
  "openai-api": "OpenAI",
  "deepseek-api": "DeepSeek",
  "zai-api": "Z.AI",
  "moonshot-api": "Moonshot",
  "cerebras-api": "Cerebras",
};

/**
 * Masked pooled-credential view — mirrors `PooledCredentialSummary` from
 * `cloud/shared/src/lib/services/team-credential-pool/service.ts`. Never
 * carries key material; `last4` is the only key-derived field.
 */
export interface PooledCredentialDto {
  id: string;
  provider: string;
  label: string;
  last4: string;
  enabled: boolean;
  priority: number;
  health: string;
  /** Mirrors `LinkedAccountHealthDetail` — `until`/`lastChecked` are epoch ms. */
  healthDetail: {
    until?: number;
    lastError?: string;
    lastChecked?: number;
  } | null;
  /** Mirrors `LinkedAccountUsage` — `resetsAt`/`refreshedAt` are epoch ms. */
  usage: {
    sessionPct?: number;
    resetsAt?: number;
    refreshedAt?: number;
  } | null;
  contributedBy: { id: string; name: string | null } | null;
  callsToday: number;
  lastUsedAt: string | null;
  createdAt: string;
}
