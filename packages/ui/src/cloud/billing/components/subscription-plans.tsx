/** Presents the provider-verified monthly catalog on public pricing and account billing surfaces, with explicit loading and unavailable states. */
import type {
  SubscriptionCheckoutConfirmationResponse,
  SubscriptionCheckoutResponse,
  SubscriptionPlansResponse,
} from "@elizaos/cloud-sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { api } from "../../lib/api-client";

export function SubscriptionPlans({
  organizationId,
}: {
  organizationId?: string;
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
  const checkout = useMutation({
    mutationFn: async (planKey: string) => {
      if (!organizationId) throw new Error("Sign in to subscribe.");
      const storageKey = `eliza-subscription-checkout:${organizationId}:${planKey}`;
      const idempotencyKey =
        localStorage.getItem(storageKey) || crypto.randomUUID();
      localStorage.setItem(storageKey, idempotencyKey);
      const response = await api<SubscriptionCheckoutResponse>(
        "/api/v1/subscriptions/checkout",
        {
          method: "POST",
          body: JSON.stringify({ planKey, idempotencyKey }),
        },
      );
      if (principal.current !== organizationId) return;
      if (response.data.status === "open" && response.data.checkoutUrl) {
        const url = new URL(response.data.checkoutUrl);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "checkout.stripe.com" ||
          url.username ||
          url.password
        )
          throw new Error("Checkout returned an invalid destination.");
        window.location.assign(url.href);
      } else if (response.data.status === "expired") {
        localStorage.removeItem(storageKey);
        setMessage(
          "The previous checkout expired. Select your plan again to start a new checkout.",
        );
      } else if (response.data.status === "completed") {
        setMessage(
          "Subscription payment confirmed. Your billing account has been updated.",
        );
        await queryClient.invalidateQueries();
      } else throw new Error("Checkout is unavailable. Please retry.");
    },
  });
  const sessionId = new URLSearchParams(window.location.search).get(
    "subscription_session_id",
  );
  const confirmation = useQuery({
    queryKey: ["subscription-checkout-confirmation", organizationId, sessionId],
    enabled: Boolean(organizationId && sessionId),
    retry: false,
    queryFn: () =>
      api<SubscriptionCheckoutConfirmationResponse>(
        "/api/v1/subscriptions/checkout/confirm",
        {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        },
      ),
  });
  useEffect(() => {
    if (confirmation.isSuccess)
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] !== "subscription-checkout-confirmation",
      });
  }, [confirmation.isSuccess, queryClient]);

  const query = useQuery({
    queryKey: ["subscription-plans"],
    queryFn: ({ signal }) =>
      api<SubscriptionPlansResponse>("/api/v1/subscriptions/plans", { signal }),
    staleTime: 0,
    retry: false,
  });
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
                  {organizationId ? (
                    <Button
                      disabled={
                        checkout.isPending ||
                        Boolean(sessionId && !confirmation.isSuccess)
                      }
                      onClick={() => checkout.mutate(plan.key)}
                    >
                      {checkout.isPending
                        ? "Opening checkout…"
                        : `Subscribe to ${plan.name}`}
                    </Button>
                  ) : (
                    <Button asChild>
                      <a href="/cloud/billing">Choose {plan.name}</a>
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
