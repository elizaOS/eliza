/** Binds app-owned client and catalog controls to the canonical free session and clears scoped state on identity changes. */
import { AppBillingAdminClient } from "@elizaos/cloud-sdk/app-billing-admin";
import { AppDelegationManagementClient } from "@elizaos/cloud-sdk/app-delegation";
import { useMemo } from "react";
import { sessionCloudSdk } from "../../lib/cloud-sdk";
import { useSessionAuth } from "../../lib/use-session-auth";
import { AppCatalogSettings } from "./app-catalog-settings";
import { AppDelegationSettings } from "./app-delegation-settings";
export function AppConnectionsSettings({
  appId,
  appName,
}: {
  appId: string;
  appName: string;
}) {
  const session = useSessionAuth();
  const clients = useMemo(
    () => ({
      delegation: new AppDelegationManagementClient(sessionCloudSdk.v1, appId),
      catalog: new AppBillingAdminClient(sessionCloudSdk.v1, appId),
    }),
    [appId],
  );
  if (!session.ready) return <p role="status">Loading app owner session…</p>;
  if (!session.user || !session.authenticated)
    return <p role="alert">Sign in to manage your app.</p>;
  const userId = session.user.id;
  return (
    <div key={`${appId}:${userId}`} className="space-y-6">
      <AppDelegationSettings client={clients.delegation} appName={appName} />
      <AppCatalogSettings
        client={clients.catalog}
        appId={appId}
        userId={userId}
      />
    </div>
  );
}
