/** Presents the provider-verified monthly catalog on public pricing and account billing surfaces, with explicit loading and unavailable states. */
import { CloudApiError } from "@elizaos/cloud-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { sessionCloudSdk } from "../../lib/cloud-sdk";
import { BILLING_SNAPSHOT_V2_QUERY_KEY } from "../data/billing-snapshot";

/** Why account billing withholds the Subscribe action; the server enforces all of these. */
export type SubscribeBlockedReason =
  | "loading"
  | "live_subscription"
  | "not_billing_manager"
  | null;

const PLAN_KEYS = ["plus_monthly", "pro_monthly"] as const;
// Same-tab fallback when storage is unavailable (private mode, blocked site data).
const memoryIntents = new Map<string, string>();

function intentStorageKey(
  userId: string,
  organizationId: string,
  plan: string,
) {
  return `eliza-subscription-checkout:${userId}:${organizationId}:${plan}`;
}
function readIntent(key: string): string | null {
  try {
    return window.localStorage.getItem(key) ?? memoryIntents.get(key) ?? null;
  } catch {
    return memoryIntents.get(key) ?? null;
  }
}
function writeIntent(key: string, value: string) {
  memoryIntents.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is optional; the in-memory intent still makes same-tab retries idempotent.
  }
}
function clearIntent(key: string) {
  memoryIntents.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage is optional; the in-memory intent is already cleared.
  }
}

function readReturnedSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(
    "subscription_session_id",
  );
}

/** Drops the provider return marker so a reload never re-confirms or re-renders a stale result. */
function dropReturnedSessionId() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("subscription_session_id")) return;
    url.searchParams.delete("subscription_session_id");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // The confirmation result is already rendered; a stale URL only re-confirms idempotently.
  }
}

function assertStripeCheckoutUrl(value: string | null): string {
  if (typeof value !== "string")
    throw new Error("Checkout returned an invalid destination.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "checkout.stripe.com" ||
    url.username ||
    url.password
  )
    throw new Error("Checkout returned an invalid destination.");
  return url.href;
}

export function SubscriptionPlans({
  organizationId,
  userId,
  subscribeBlockedReason = null,
}: {
  organizationId?: string;
  userId?: string;
  subscribeBlockedReason?: SubscribeBlockedReason;
}) {
  const queryClient = useQueryClient();
  const principal = useRef(organizationId);
  principal.current = organizationId;
  useEffect(() => {
    principal.current = organizationId;
    return () => {
      principal.current = undefined;
    };
  }, [organizationId]);
  const [message, setMessage] = useState<string | null>(null);
  const intentOwner = userId ?? "session";

  const invalidateBilling = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY,
      }),
      queryClient.invalidateQueries({ queryKey: ["credits", "balance"] }),
    ]);

  const checkout = useMutation({
    mutationFn: async (planKey: (typeof PLAN_KEYS)[number]) => {
      if (!organizationId) throw new Error("Sign in to subscribe.");
      const storageKey = intentStorageKey(intentOwner, organizationId, planKey);
      // A spent intent (already bought, now ended) is replaced once with a fresh one.
      for (let attempt = 0; attempt < 2; attempt++) {
        const idempotencyKey = readIntent(storageKey) ?? crypto.randomUUID();
        writeIntent(storageKey, idempotencyKey);
        let response: Awaited<
          ReturnType<typeof sessionCloudSdk.startSubscriptionCheckout>
        >;
        try {
          response = await sessionCloudSdk.startSubscriptionCheckout({
            planKey,
            idempotencyKey,
          });
        } catch (error) {
          // A conflict is terminal for this intent; retries keep the key only while uncertain.
          if (error instanceof CloudApiError && error.statusCode === 409)
            clearIntent(storageKey);
          throw error;
        }
        if (principal.current !== organizationId) return;
        const result = response.data;
        switch (result.status) {
          case "open":
            window.location.assign(assertStripeCheckoutUrl(result.checkoutUrl));
            return;
          case "completed":
            clearIntent(storageKey);
            setMessage(
              "Subscription payment confirmed. Your billing account has been updated.",
            );
            await invalidateBilling();
            return;
          case "expired":
            clearIntent(storageKey);
            setMessage(
              "The previous checkout expired. Select your plan again to start a new checkout.",
            );
            return;
          case "stale_intent":
            clearIntent(storageKey);
            continue;
          default:
            throw new Error("Checkout is unavailable. Please retry.");
        }
      }
      throw new Error("Checkout is unavailable. Please retry.");
    },
  });

  const [sessionId] = useState(readReturnedSessionId);
  const confirmation = useQuery({
    queryKey: ["subscription-checkout-confirmation", organizationId, sessionId],
    enabled: Boolean(organizationId && sessionId),
    retry: false,
    queryFn: () =>
      sessionCloudSdk.confirmSubscriptionCheckout(sessionId as string),
  });
  useEffect(() => {
    if (!confirmation.isSuccess || !organizationId) return;
    for (const plan of PLAN_KEYS)
      clearIntent(intentStorageKey(intentOwner, organizationId, plan));
    dropReturnedSessionId();
    void queryClient.invalidateQueries({
      queryKey: BILLING_SNAPSHOT_V2_QUERY_KEY,
    });
    void queryClient.invalidateQueries({ queryKey: ["credits", "balance"] });
  }, [confirmation.isSuccess, organizationId, intentOwner, queryClient]);

  const query = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: () => sessionCloudSdk.getSubscriptionPlans(),
    staleTime: 0,
    retry: false,
  });
  const subscribeHidden =
    subscribeBlockedReason === "live_subscription" ||
    subscribeBlockedReason === "not_billing_manager";
  return (
    <section
      aria-labelledby="subscription-plans-heading"
      className="space-y-4 mb-8"
    >
      <div>
        <h2 id="subscription-plans-heading" className="text-2xl font-semibold">
          Monthly subscriptions
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          A monthly allowance for AI, agent hosting, and other eligible usage.
          Purchased credits remain separate.
        </p>
      </div>
      {message ? <p role="status">{message}</p> : null}
      {checkout.isError ? <p role="alert">{checkout.error.message}</p> : null}
      {sessionId && organizationId ? (
        confirmation.isSuccess ? (
          <p role="status">
            Subscription payment confirmed. Your billing account has been
            updated.
          </p>
        ) : confirmation.isError ? (
          <div role="alert">
            <p>
              Payment confirmation is unavailable. Retry to check your existing
              checkout.
            </p>
            <Button
              onClick={() => void confirmation.refetch()}
              disabled={confirmation.isFetching}
            >
              Check payment
            </Button>
          </div>
        ) : (
          <p role="status">Confirming your subscription…</p>
        )
      ) : null}
      {organizationId && subscribeBlockedReason === "live_subscription" ? (
        <p className="text-sm text-muted-foreground">
          Your organization already has a subscription. Plan changes are not
          available yet.
        </p>
      ) : null}
      {organizationId && subscribeBlockedReason === "not_billing_manager" ? (
        <p className="text-sm text-muted-foreground">
          Only organization owners and admins can subscribe.
        </p>
      ) : null}
      {query.isPending ? (
        <p role="status">Loading subscription plans…</p>
      ) : null}
      {query.isError ? (
        <div role="alert" className="space-y-3">
          <p>
            Subscription plans are temporarily unavailable. Please try again.
          </p>
          <Button
            variant="outline"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {query.data && !query.isError ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {query.data.data.plans.map((plan) => (
              <Card key={plan.key}>
                <CardHeader>
                  <CardTitle>{plan.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p>
                    <strong className="text-4xl">
                      {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: plan.currency,
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      }).format(plan.amountCents / 100)}
                    </strong>
                    <span className="text-muted-foreground"> / month</span>
                  </p>
                  <p>
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: plan.currency,
                      maximumFractionDigits: 2,
                    }).format(Number(plan.allowance.amountUsd))}{" "}
                    in eligible usage each billing period.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Unused allowance expires at the end of the billing period
                    and does not roll over.
                  </p>
                  {!organizationId ? (
                    <Button asChild>
                      <a href="/cloud/billing">Choose {plan.name}</a>
                    </Button>
                  ) : subscribeHidden ? null : (
                    <Button
                      disabled={
                        checkout.isPending ||
                        subscribeBlockedReason === "loading" ||
                        Boolean(sessionId && !confirmation.isSuccess)
                      }
                      onClick={() => checkout.mutate(plan.key)}
                    >
                      {checkout.isPending
                        ? "Opening checkout…"
                        : `Subscribe to ${plan.name}`}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Subscriptions renew monthly until canceled. Confirm your plan and
            payment on Stripe before any charge. Purchased credits are separate.
          </p>
        </>
      ) : null}
    </section>
  );
}
