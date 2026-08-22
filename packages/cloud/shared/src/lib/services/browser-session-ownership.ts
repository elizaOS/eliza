/** Defines the exact user and organization ownership rule for hosted browser sessions. */

export interface HostedBrowserSessionOwner {
  organizationId: string;
  userId: string | null;
}

export interface HostedBrowserSessionRequester {
  organizationId?: string;
  userId?: string;
}

export function isHostedBrowserSessionOwner(
  access: HostedBrowserSessionOwner,
  auth?: HostedBrowserSessionRequester,
): boolean {
  const organizationId = auth?.organizationId?.trim();
  const userId = auth?.userId?.trim() || null;
  return (
    Boolean(organizationId) &&
    access.organizationId === organizationId &&
    (access.userId === null || access.userId === userId)
  );
}
