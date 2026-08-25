/** Rechecks account authority around provisioning preparation before provider execution. */

import {
  AccountLifecycleFencedError,
  type OrganizationLifecycleAuthority,
  requireActiveOrganizationLifecycle,
} from "./account-lifecycle-authority";
import {
  acquireProviderAdmission,
  type ProviderAdmissionAuthority,
  releaseProviderAdmission,
} from "./provider-admission";

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

/**
 * Holds a durable admission from the final lifecycle check until the provider
 * outcome has been recorded by the caller. Deletion activation locks the same
 * organization row and cannot fence the account while this admission is live.
 */
export async function executeProvisioningWithAccountLifecycleAdmission<T>(input: {
  authority: ProviderAdmissionAuthority;
  execute: () => Promise<T>;
  acquire?: typeof acquireProviderAdmission;
  release?: typeof releaseProviderAdmission;
}): Promise<T> {
  const acquire = input.acquire ?? acquireProviderAdmission;
  const release = input.release ?? releaseProviderAdmission;
  if (!(await acquire(input.authority))) {
    throw new AccountLifecycleFencedError();
  }
  try {
    return await input.execute();
  } finally {
    await release(input.authority);
  }
}
