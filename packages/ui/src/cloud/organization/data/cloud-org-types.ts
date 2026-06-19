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
 * `packages/cloud-api/organizations/**` and
 * `packages/cloud-shared/src/types/cloud-api.ts`).
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
