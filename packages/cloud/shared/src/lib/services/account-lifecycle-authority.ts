/** Primary-writer lifecycle authority checked at final paid/provider boundaries. */

import { ElizaError } from "@elizaos/core";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import { organizations } from "../../db/schemas/organizations";

export interface OrganizationLifecycleAuthority {
  state: "active" | "deletion_recovery" | "deletion_irreversible";
  revision: number;
  active: boolean;
  deletionRequestId: string | null;
}

export class AccountLifecycleFencedError extends Error {
  readonly code = "ACCOUNT_LIFECYCLE_FENCED";

  constructor() {
    super("Account lifecycle does not authorize new provider or paid work");
    this.name = "AccountLifecycleFencedError";
  }
}

function isOrganizationLifecycleState(
  state: string,
): state is OrganizationLifecycleAuthority["state"] {
  return state === "active" || state === "deletion_recovery" || state === "deletion_irreversible";
}

/** Reads the canonical account authority from the primary, never a replica/cache. */
export async function readOrganizationLifecycleAuthority(
  organizationId: string,
  reader: Pick<DbTransaction, "select"> = dbWrite,
): Promise<OrganizationLifecycleAuthority | null> {
  const [organization] = await reader
    .select({
      state: organizations.account_lifecycle_state,
      revision: organizations.account_lifecycle_revision,
      active: organizations.is_active,
      deletionRequestId: organizations.account_deletion_request_id,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!organization || !isOrganizationLifecycleState(organization.state)) {
    return null;
  }
  return { ...organization, state: organization.state };
}

export function organizationLifecycleAllowsNewWork(
  authority: OrganizationLifecycleAuthority | null,
): authority is OrganizationLifecycleAuthority {
  return (
    authority !== null &&
    authority.active &&
    authority.state === "active" &&
    authority.deletionRequestId === null
  );
}

export async function requireActiveOrganizationLifecycle(
  organizationId: string,
  expectedRevision?: number,
): Promise<OrganizationLifecycleAuthority> {
  const authority = await readOrganizationLifecycleAuthority(organizationId);
  if (
    !organizationLifecycleAllowsNewWork(authority) ||
    (expectedRevision !== undefined && authority.revision !== expectedRevision)
  ) {
    throw new AccountLifecycleFencedError();
  }
  return authority;
}

/** Admission requires canonical irreversible account state before waiving recovery capture. */
export async function requireIrreversibleOrganizationDeletion(
  organizationId: string,
  reader: Pick<DbTransaction, "select"> = dbWrite,
  expected?: { deletionRequestId: string; revision: number },
): Promise<OrganizationLifecycleAuthority & { deletionRequestId: string }> {
  const authority = await readOrganizationLifecycleAuthority(organizationId, reader);
  if (
    !authority ||
    authority.active ||
    authority.state !== "deletion_irreversible" ||
    !authority.deletionRequestId ||
    !Number.isSafeInteger(authority.revision) ||
    authority.revision <= 0 ||
    (expected !== undefined &&
      (authority.deletionRequestId !== expected.deletionRequestId ||
        authority.revision !== expected.revision))
  ) {
    throw new ElizaError("Account lifecycle does not authorize irreversible agent deletion", {
      code: "ACCOUNT_DELETION_PURGE_NOT_AUTHORIZED",
      context: { organizationId },
    });
  }
  return { ...authority, deletionRequestId: authority.deletionRequestId };
}
