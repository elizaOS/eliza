/** Resolves a configured native product before mounting the same purchaser billing flow used by independently registered apps. */
import type { AppBillingApplicationProduct } from "@elizaos/cloud-sdk/app-billing";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "../../../components/ui/button";
import { sessionCloudSdk } from "../../lib/cloud-sdk";
import { useSessionAuth } from "../../lib/use-session-auth";
import { ConsolePage } from "../../shell/ConsolePage";
import { AppBillingPanel } from "./AppBillingPanel";

type ProductState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; product: AppBillingApplicationProduct };

function ProductBilling({
  slotKey,
  userId,
}: {
  slotKey: string;
  userId: string;
}) {
  const [state, setState] = useState<ProductState>({ kind: "loading" });
  const [request, setRequest] = useState({ slotKey });
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void sessionCloudSdk.getApplicationBillingProduct(request.slotKey).then(
      ({ data }) => {
        if (current) setState({ kind: "ready", product: data });
      },
      (error: Error) => {
        // error-policy:J4 Unavailable configuration remains visible and cannot choose another product or prepaid funding.
        if (current) setState({ kind: "error", message: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  const appId = state.kind === "ready" ? state.product.appId : null;
  const client = useMemo(
    () => (appId ? sessionCloudSdk.appBilling(appId) : null),
    [appId],
  );
  if (state.kind === "loading")
    return <p role="status">Loading product billing…</p>;
  if (state.kind === "error")
    return (
      <section aria-label="Product billing unavailable">
        <p role="alert">{state.message}</p>
        <Button size="touch" onClick={() => setRequest({ slotKey })}>
          Retry
        </Button>
      </section>
    );
  if (!client)
    throw new Error("Loaded product billing requires its app client");
  const product = state.product;
  return (
    <section
      aria-label={`${product.appName} subscription`}
      className="space-y-4"
    >
      <h1>{product.appName} subscription</h1>
      <p>
        This subscription covers this app. Developer infrastructure credits are
        billed separately.
      </p>
      <AppBillingPanel
        client={client}
        appId={product.appId}
        productFamilyKey={product.productFamilyKey}
        userId={userId}
      />
    </section>
  );
}

export default function NativeProductBillingPage() {
  const { slotKey } = useParams();
  const session = useSessionAuth();
  return (
    <ConsolePage>
      {!session.ready ? (
        <p role="status">Loading your account…</p>
      ) : !session.authenticated || !session.user ? (
        <p>
          Sign in with your free Eliza account to manage this product
          subscription.{" "}
          <a
            href={`/login?redirect=${encodeURIComponent(window.location.pathname)}`}
          >
            Sign in
          </a>
        </p>
      ) : !slotKey ? (
        <p role="alert">
          Open subscription settings from the app you want to manage.
        </p>
      ) : (
        <ProductBilling
          key={`${slotKey}:${session.user.id}`}
          slotKey={slotKey}
          userId={session.user.id}
        />
      )}
    </ConsolePage>
  );
}
