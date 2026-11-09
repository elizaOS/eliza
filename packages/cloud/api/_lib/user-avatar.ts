/**
 * Avatar replacement for POST /api/v1/user/avatar and PATCH /api/v1/user.
 *
 * Each upload writes a new public object under
 * `avatars/users/<org>/<user>/` and reserves its bytes against the org quota.
 * Replacing or clearing the avatar must remove the previous object and give
 * its bytes back, or the old photo stays public and the quota fills with
 * objects nobody can see or delete.
 */

import { writeTransaction } from "@elizaos/cloud-shared/db/helpers";
import { orgStorageQuotaRepository } from "@elizaos/cloud-shared/db/repositories/org-storage-quota";
import { type User, users } from "@elizaos/cloud-shared/db/schemas/users";
import { publicUrlForR2Key } from "@elizaos/cloud-shared/lib/storage/r2-public-object";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type {
  AppContext,
  Bindings,
} from "@elizaos/cloud-shared/types/cloud-worker-env";
import { and, eq, type SQL } from "drizzle-orm";

export interface AvatarSwap {
  updated: User | undefined;
  previousAvatar: string | null;
}

/**
 * Set `users.avatar` and return the value it replaced. The row lock makes each
 * previous value visible to exactly one replacing write, so two concurrent
 * replacements never clean up the same object.
 */
export async function swapUserAvatar(
  userId: string,
  organizationId: string | null,
  avatar: string | null,
): Promise<AvatarSwap> {
  const where: SQL | undefined = organizationId
    ? and(eq(users.id, userId), eq(users.organization_id, organizationId))
    : eq(users.id, userId);
  return writeTransaction(async (tx) => {
    const [current] = await tx
      .select({ avatar: users.avatar })
      .from(users)
      .where(where)
      .for("update");
    if (!current) return { updated: undefined, previousAvatar: null };
    const [updated] = await tx
      .update(users)
      .set({ avatar })
      .where(where)
      .returning();
    return { updated, previousAvatar: current.avatar };
  });
}

/**
 * The R2 key behind `url` when it is an avatar this route uploaded for this
 * user on the current public host; null for external URLs and anything else.
 */
export function ownedAvatarKey(
  env: Pick<Bindings, "R2_PUBLIC_HOST">,
  url: string,
  organizationId: string,
  userId: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 a stored avatar that is not a URL is not ours to delete.
    return null;
  }
  const key = parsed.pathname.slice(1);
  const prefix = `avatars/users/${organizationId}/${userId}/`;
  if (!key.startsWith(prefix) || key.slice(prefix.length).includes("/")) {
    return null;
  }
  return publicUrlForR2Key(env as Bindings, key) === url ? key : null;
}

async function releaseReplacedAvatar(
  env: Bindings,
  organizationId: string,
  userId: string,
  previousAvatar: string,
): Promise<void> {
  const key = ownedAvatarKey(env, previousAvatar, organizationId, userId);
  if (!key || typeof env.BLOB.head !== "function") return;
  try {
    // The object's size is the only record of the bytes it reserved. A missing
    // object was already removed (and released) by an earlier attempt, so a
    // repeat run releases nothing.
    const head = await env.BLOB.head(key);
    if (!head) return;
    await env.BLOB.delete(key);
    await orgStorageQuotaRepository.releaseBytes(
      organizationId,
      BigInt(head.size),
    );
  } catch (error) {
    // error-policy:J6 cleanup of a replaced avatar runs after the new avatar
    // is committed; a failure leaves the old object and its reservation.
    logger.warn("[User Avatar] Failed to remove replaced avatar", {
      organizationId: logger.redact.orgId(organizationId),
      userId: logger.redact.userId(userId),
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

function getWaitUntil(
  c: AppContext,
): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx;
    if (typeof executionCtx?.waitUntil !== "function") return undefined;
    return executionCtx.waitUntil.bind(executionCtx);
  } catch {
    // error-policy:J4 Hono local/test contexts omit ExecutionContext; run the
    // cleanup inline instead.
    return undefined;
  }
}

/** Remove the replaced avatar after the response, or inline without a Worker context. */
export async function scheduleReplacedAvatarCleanup(
  c: AppContext,
  organizationId: string | null,
  userId: string,
  previousAvatar: string | null,
  currentAvatar: string | null,
): Promise<void> {
  if (!organizationId || !previousAvatar || previousAvatar === currentAvatar) {
    return;
  }
  const cleanup = releaseReplacedAvatar(
    c.env,
    organizationId,
    userId,
    previousAvatar,
  );
  const waitUntil = getWaitUntil(c);
  if (waitUntil) waitUntil(cleanup);
  else await cleanup;
}
