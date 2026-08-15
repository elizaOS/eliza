/** Pure canonical-account authorization policy for managed Discord guild audio. */

export interface ManagedDiscordGuildVoiceIdentity {
  allowed: boolean;
  userId?: string;
  organizationId?: string;
  reason?: "identity_not_linked" | "not_owner";
}

export function evaluateManagedDiscordGuildVoiceOwner(
  account:
    | {
        id: string;
        role: string;
        organization_id: string | null;
        organization?: { id: string } | null;
      }
    | null
    | undefined,
): ManagedDiscordGuildVoiceIdentity {
  if (!account?.organization) {
    return { allowed: false, reason: "identity_not_linked" };
  }
  if (account.role !== "owner" || account.organization_id !== account.organization.id) {
    return { allowed: false, reason: "not_owner" };
  }
  return {
    allowed: true,
    userId: account.id,
    organizationId: account.organization.id,
  };
}
