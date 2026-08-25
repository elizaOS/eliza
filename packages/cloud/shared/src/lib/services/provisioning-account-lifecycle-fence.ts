/** Rechecks account authority around provisioning preparation before provider execution. */

import {
  type OrganizationLifecycleAuthority,
  requireActiveOrganizationLifecycle,
} from "./account-lifecycle-authority";

type AuthorityReader = (
  organizationId: string,
  expectedRevision?: number,
) => Promise<OrganizationLifecycleAuthority>;

/**
 * Captures active authority, performs database-only job preparation, then
 * rechecks the exact revision before the caller may enter a provider handler.
 */
export async function prepareProvisioningWithAccountLifecycleFence(
  organizationId: string,
  prepare: () => Promise<void>,
  readAuthority: AuthorityReader = requireActiveOrganizationLifecycle,
): Promise<void> {
  const authority = await readAuthority(organizationId);
  await prepare();
  await readAuthority(organizationId, authority.revision);
}
