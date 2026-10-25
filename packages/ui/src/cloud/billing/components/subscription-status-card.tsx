/**
 * Shows the organization's Plus/Pro subscription from the server billing snapshot, with
 * period-end cancel/undo driven by the server-owned control and a Customer Portal entry for
 * billing managers (including past-due and unpaid subscriptions that need a new card).
 */
import type { Observed } from "@elizaos/cloud-sdk/account-billing-snapshot";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { sessionCloudSdk } from "../../lib/cloud-sdk";
import {
  BILLING_SNAPSHOT_V2_QUERY_KEY,
  type BillingSubscriptionView,
} from "../data/billing-snapshot";

const PLAN_NAMES = { plus_monthly: "Plus", pro_monthly: "Pro" } as const;
const STATE_LABELS: Record<BillingSubscriptionView["state"], string> = {
  pending: "Pending",
  incomplete: "Incomplete",
  active: "Active",
  grace: "Payment grace period",
  past_due: "Payment past due",
  unpaid: "Unpaid",
  canceled: "Canceled",
  incomplete_expired: "Expired",
};
const CANCELLATION_POLL_MS = 2_000;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

function formatUsd(value: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function assertPortalUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "billing.stripe.com" ||
    url.username ||
    url.password
  )
    throw new Error("Billing management returned an invalid destination.");
  return url.href;
}

/** Billing-manager status derives from the server control, never from client role guesses. */
export function isSubscriptionBillingManager(
  subscription: BillingSubscriptionView,
): boolean {
  const blockers = subscription.cancellationControl.blockers;
  return (
    !blockers.includes("owner_or_admin_role_required") &&
    !blockers.includes("interactive_session_required") &&
    !blockers.includes("billing_account_ineligible")
  );
}

export function SubscriptionStatusCard({
  subscription,
}: {
  subscription: Observed<BillingSubscriptionView> | undefined;
}) {
  if (!subscription || subscription.status === "not_applicable") return null;
  if (subscription.status !== "available")
    return (
      <Alert variant="warning" className="mb-6" role="status">
        Subscription status is temporarily unavailable. Refresh to try again.
      </Alert>
    );
  return <SubscriptionStatusBody subscription={subscription.value} />;
}

function SubscriptionStatusBody({
  subscription,
}: {
  subscription: BillingSubscriptionView;
}) {
  const queryClient = useQueryClient();
  const control = subscription.cancellationControl;
  const manager = isSubscriptionBillingManager(subscription);
  const [confirming, setConfirming] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  // One idempotency key per (action, subscription revision); retries reuse it.
  const intent = useRef<{ scope: string; key: string } | null>(null);
  const scope = `${control.action}:${control.subscriptionId}:${control.expectedSubscriptionRevision}`;

  const refreshSnapshot = () =>
    queryClient.invalidateQueries({ queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY });

  const cancellation = useMutation({
    mutationFn: async () => {
      if (intent.current?.scope !== scope)
        intent.current = { scope, key: crypto.randomUUID() };
      const input = {
        subscriptionId: control.subscriptionId,
        expectedSubscriptionRevision: control.expectedSubscriptionRevision,
        idempotencyKey: intent.current.key,
      };
      const response =
        control.action === "undo"
          ? await sessionCloudSdk.submitOrganizationSubscriptionCancellationUndo(
              input,
            )
          : await sessionCloudSdk.submitOrganizationSubscriptionCancellation(
              input,
            );
      return response.data;
    },
    onSuccess: async (result) => {
      setConfirming(false);
      if (result.status === "PREPARED" || result.status === "OUTCOME_UNKNOWN") {
        setCommandId(result.commandId);
        return;
      }
      intent.current = null;
      await refreshSnapshot();
    },
  });

  const polling = useQuery({
    queryKey: ["subscription-cancellation-command", control.action, commandId],
    enabled: commandId !== null,
    retry: false,
    queryFn: async () =>
      (control.action === "undo"
        ? await sessionCloudSdk.readOrganizationSubscriptionCancellationUndo(
            commandId as string,
          )
        : await sessionCloudSdk.readOrganizationSubscriptionCancellation(
            commandId as string,
          )
      ).data,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === undefined ||
        status === "PREPARED" ||
        status === "OUTCOME_UNKNOWN"
        ? CANCELLATION_POLL_MS
        : false;
    },
  });
  const settledStatus = polling.data?.status;
  useEffect(() => {
    if (
      settledStatus === undefined ||
      settledStatus === "PREPARED" ||
      settledStatus === "OUTCOME_UNKNOWN"
    )
      return;
    intent.current = null;
    setCommandId(null);
    void queryClient.invalidateQueries({
      queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY,
    });
  }, [settledStatus, queryClient]);

  const portal = useMutation({
    mutationFn: async () => {
      const response = await sessionCloudSdk.createSubscriptionPortalSession();
      window.location.assign(assertPortalUrl(response.data.url));
    },
  });

  const pendingCommand = commandId !== null;
  const needsPaymentAttention =
    subscription.state === "past_due" ||
    subscription.state === "unpaid" ||
    subscription.state === "grace";
  const allowance =
    subscription.allowance.status === "available"
      ? subscription.allowance.value
      : null;
  const remaining =
    allowance?.effectiveRemaining.status === "available"
      ? allowance.effectiveRemaining.value
      : null;

  return (
    <Card className="mb-6" aria-labelledby="subscription-status-heading">
      <CardHeader>
        <CardTitle id="subscription-status-heading">
          {PLAN_NAMES[subscription.planKey]} subscription
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p>
          <span className="font-medium">Status:</span>{" "}
          {STATE_LABELS[subscription.state]}
        </p>
        {subscription.state !== "canceled" &&
        subscription.state !== "incomplete_expired" ? (
          <p>
            {subscription.cancelAtPeriodEnd
              ? `Cancels on ${formatDate(subscription.currentPeriodEnd)}. You keep access until then.`
              : `Renews on ${formatDate(subscription.currentPeriodEnd)}.`}
          </p>
        ) : null}
        {subscription.graceExpiresAt ? (
          <p>
            Update your payment method before{" "}
            {formatDate(subscription.graceExpiresAt)} to keep your plan.
          </p>
        ) : null}
        {allowance ? (
          <p>
            Allowance:{" "}
            {remaining === null ? "unavailable" : formatUsd(remaining)}{" "}
            remaining of {formatUsd(allowance.granted)} this period.
          </p>
        ) : null}
        {needsPaymentAttention ? (
          <Alert variant="warning" role="status">
            Your last subscription payment did not go through.
            {manager
              ? " Update your payment method to keep your plan."
              : " Ask an organization owner or admin to update the payment method."}
          </Alert>
        ) : null}
        {cancellation.isError ? (
          <p role="alert">{cancellation.error.message}</p>
        ) : null}
        {polling.isError ? (
          <p role="alert">
            The cancellation request is still being confirmed. Refresh to check
            its status.
          </p>
        ) : null}
        {portal.isError ? <p role="alert">{portal.error.message}</p> : null}
        {pendingCommand ? (
          <p role="status">Confirming your subscription change…</p>
        ) : null}
        {manager ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={needsPaymentAttention ? "default" : "outline"}
              disabled={portal.isPending}
              onClick={() => portal.mutate()}
            >
              {portal.isPending
                ? "Opening billing…"
                : needsPaymentAttention
                  ? "Update payment method"
                  : "Manage billing"}
            </Button>
            {control.eligible && !pendingCommand ? (
              control.action === "undo" ? (
                <Button
                  variant="outline"
                  disabled={cancellation.isPending}
                  onClick={() => cancellation.mutate()}
                >
                  Keep subscription
                </Button>
              ) : confirming ? (
                <>
                  <Button
                    variant="destructive"
                    disabled={cancellation.isPending}
                    onClick={() => cancellation.mutate()}
                  >
                    Confirm cancellation at period end
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={cancellation.isPending}
                    onClick={() => setConfirming(false)}
                  >
                    Keep plan
                  </Button>
                </>
              ) : (
                <Button variant="outline" onClick={() => setConfirming(true)}>
                  Cancel subscription
                </Button>
              )
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
