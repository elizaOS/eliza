import { ForbiddenError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";

/**
 * Who may change an API key in their organization. Organization membership
 * alone is not enough: a key acts as the user it belongs to, so a member who
 * could manage another user's key could revoke it, or regenerate it and
 * receive a working plaintext key for that user (an owner's key acts as the
 * owner).
 *
 * - `revoke` (delete, disable, edit): the key's own user, or an owner/admin.
 * - `regenerate` (returns the new plaintext): the key's own user only.
 */
export function assertCanManageApiKey(
  user: { id: string; role?: string | null },
  key: { user_id: string | null },
  action: "revoke" | "regenerate",
): void {
  if (key.user_id === user.id) return;
  if (action === "revoke" && (user.role === "owner" || user.role === "admin"))
    return;
  throw ForbiddenError(
    action === "regenerate"
      ? "Only the user an API key belongs to can regenerate it"
      : "Only the key's user or an organization owner or admin can change this API key",
  );
}
