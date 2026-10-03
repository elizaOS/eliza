/** Mounts independent app billing using the existing free identity session and canonical SDK transport. */
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { sessionCloudSdk } from "../../lib/cloud-sdk";
import { useSessionAuth } from "../../lib/use-session-auth";
import { ConsolePage } from "../../shell/ConsolePage";
import { AppBillingPanel } from "./AppBillingPanel";

export default function AppBillingPage() {
  const { appId, productFamilyKey } = useParams();
  const [search] = useSearchParams();
  const clientId = search.get("clientId") ?? undefined;
  const accountId = search.get("accountId") ?? undefined;
  const session = useSessionAuth();
  const client = useMemo(
    () =>
      appId
        ? new AppBillingClient(sessionCloudSdk.v1, appId, { clientId })
        : null,
    [appId, clientId],
  );
  if (!session.ready)
    return (
      <ConsolePage>
        <p role="status">Loading your account…</p>
      </ConsolePage>
    );
  if (!appId || !productFamilyKey || !client)
    return (
      <ConsolePage>
        <p role="alert">Open billing from the app you want to manage.</p>
      </ConsolePage>
    );
  if (!session.authenticated || !session.user)
    return (
      <ConsolePage>
        <p>
          Sign in with your free Eliza account to manage this app subscription.
        </p>
        <a
          href={`/login?redirect=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`}
        >
          Sign in
        </a>
      </ConsolePage>
    );
  return (
    <ConsolePage>
      <AppBillingPanel
        client={client}
        appId={appId}
        productFamilyKey={productFamilyKey}
        userId={session.user.id}
        clientId={clientId}
        accountId={accountId}
      />
    </ConsolePage>
  );
}
