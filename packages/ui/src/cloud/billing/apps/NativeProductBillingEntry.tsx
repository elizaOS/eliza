/** Links settings to the runtime-selected app subscription independently of developer infrastructure billing readiness. */
import type { NativeApplicationBillingSelection } from "@elizaos/cloud-sdk/app-billing";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { client } from "../../../api";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";

type SelectionState = NativeApplicationBillingSelection | { kind: "loading" };

export function NativeProductBillingEntry() {
  const [state, setState] = useState<SelectionState>({ kind: "loading" });
  const [request, setRequest] = useState({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit refresh request repeats the authoritative runtime read.
  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void client.getCloudStatus().then(
      (status) => {
        if (current)
          setState(
            status.applicationBilling ?? {
              kind: "unavailable",
              reason:
                "This host has not provided its application billing selection.",
            },
          );
      },
      (error: Error) => {
        // error-policy:J4 A failed runtime read cannot imply that prepaid funding or another product is selected.
        if (current) setState({ kind: "unavailable", reason: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [request]);
  return (
    <Card className="mb-6 p-4 space-y-3">
      <h2>App subscription</h2>
      {state.kind === "loading" ? (
        <p role="status">Loading the app's billing selection…</p>
      ) : state.kind === "configured" ? (
        <>
          <p>
            Manage this app's selected subscription. Your developer
            infrastructure account is billed separately.
          </p>
          <Button asChild size="touch">
            <Link
              to={`/cloud/billing/products/${encodeURIComponent(state.slotKey)}`}
            >
              Manage app subscription
            </Link>
          </Button>
        </>
      ) : state.kind === "unconfigured" ? (
        <p>No app subscription product is selected for this host.</p>
      ) : (
        <p role="alert">{state.reason}</p>
      )}
      {state.kind === "unavailable" && (
        <Button size="touch" onClick={() => setRequest({})}>
          Retry product selection
        </Button>
      )}
    </Card>
  );
}
