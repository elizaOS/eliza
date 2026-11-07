import {
  CalendarSyncError,
  type CalendarSyncOwner,
  ManagedCalendarSyncProvider,
} from "./calendar-sync-provider";
import { getGoogleAccessToken, getManagedGoogleConnectorStatus } from "./shared";

async function current(owner: CalendarSyncOwner) {
  const status = await getManagedGoogleConnectorStatus({
    organizationId: owner.organizationId,
    userId: owner.userId,
    grantId: owner.grantId,
    side: "owner",
  });
  if (
    !status.connected ||
    status.connectionId !== owner.grantId ||
    typeof status.identity?.id !== "string" ||
    !status.identity.id
  )
    throw new CalendarSyncError(
      403,
      "CALENDAR_SYNC_PERMISSION",
      "not_accepted",
      "The selected owner Calendar connection is unavailable.",
    );
  return {
    connectionId: owner.grantId,
    accountId: status.identity.id,
    ...(typeof status.identity.email === "string" ? { accountEmail: status.identity.email } : {}),
    capabilities: status.grantedCapabilities,
  };
}
export const managedCalendarSyncProvider = new ManagedCalendarSyncProvider({
  current,
  async grant(owner: CalendarSyncOwner, write: boolean) {
    const scope = {
      organizationId: owner.organizationId,
      userId: owner.userId,
      grantId: owner.grantId,
      side: "owner" as const,
    };
    const before = await current(owner);
    if (owner.accountId !== undefined && owner.accountId !== before.accountId)
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected Google account changed.",
      );
    if (
      !before.capabilities.includes("google.calendar.read") ||
      (write && !before.capabilities.includes("google.calendar.write"))
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected Calendar permission is unavailable.",
      );
    const token = await getGoogleAccessToken(scope),
      latest = await current(owner);
    if (
      token.connectionId !== owner.grantId ||
      before.accountId !== latest.accountId ||
      JSON.stringify([...before.capabilities].sort()) !==
        JSON.stringify([...latest.capabilities].sort())
    )
      throw new CalendarSyncError(
        403,
        "CALENDAR_SYNC_PERMISSION",
        "not_accepted",
        "The selected owner Calendar connection changed.",
      );
    return {
      connectionId: token.connectionId,
      accountId: latest.accountId,
      accountEmail: latest.accountEmail,
      token: token.accessToken,
      capabilities: latest.capabilities,
    };
  },
});
