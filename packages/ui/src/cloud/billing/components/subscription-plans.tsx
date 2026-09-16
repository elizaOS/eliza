/** Presents the provider-verified monthly catalog on public pricing and account billing surfaces, with explicit loading and unavailable states. */
import type { SubscriptionPlansResponse } from "@elizaos/cloud-sdk";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { api } from "../../lib/api-client";

export function SubscriptionPlans() {
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
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            Subscription checkout is not available yet. Purchasing credits does
            not start a subscription.
          </p>
        </>
      ) : null}
    </section>
  );
}
