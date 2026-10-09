/** Renders independent app subscription terms and authoritative access, with explicit confirmation before billing changes. */
import { useEffect, useId, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { NativeSelect } from "../../../components/ui/native-select";
import { AppBillingRecords } from "./AppBillingRecords";
import { billingHostedUrl } from "./billing-intent";
import { type AppBillingPanelProps, useAppBilling } from "./use-app-billing";

export function money(amountCents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}
const date = (value: string) => new Date(value).toLocaleString();

export function AppBillingPanel(props: AppBillingPanelProps) {
  return (
    <AppBillingAccountPanel
      key={JSON.stringify([
        props.userId,
        props.appId,
        props.clientId,
        props.accountId,
        props.productFamilyKey,
      ])}
      {...props}
    />
  );
}
function AppBillingAccountPanel(props: AppBillingPanelProps) {
  const billing = useAppBilling(props);
  const inputId = useId();
  const [planId, setPlanId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [confirmation, setConfirmation] = useState<
    "checkout" | "cancel" | null
  >(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const { loaded, busy, error, operation, pending, quote } = billing;
  const plans = loaded?.catalog.plans.filter(
    (plan) => plan.productFamilyKey === props.productFamilyKey,
  );
  const plan =
    plans?.find((candidate) => candidate.id === planId) ?? plans?.[0];
  useEffect(() => {
    if (plan)
      setQuantity((previous) =>
        Math.min(plan.seats.maximum, Math.max(plan.seats.minimum, previous)),
      );
  }, [plan]);
  if (!loaded)
    return (
      <section aria-label="App subscription" className="space-y-4">
        <p role={error ? "alert" : "status"}>
          {error ?? "Loading app subscription…"}
        </p>
        {error && (
          <Button size="touch" onClick={() => void billing.refresh()}>
            Retry
          </Button>
        )}
      </section>
    );
  const { snapshot, catalog } = loaded;
  const expired =
    snapshot.entitlement !== null &&
    new Date(snapshot.entitlement.validUntil).getTime() <= now;
  const canManage = snapshot.account.role === "administrator";
  const disabled = busy || !billing.ready || pending !== null || !canManage;
  const selectedValid =
    plan &&
    Number.isSafeInteger(quantity) &&
    quantity >= plan.seats.minimum &&
    quantity <= plan.seats.maximum;
  const command = () => ({
    idempotencyKey: crypto.randomUUID(),
    expectedSubscriptionRevision: snapshot.mutationRevision,
  });
  const terms = plan
    ? `${money(plan.amountCents, plan.currency)} per seat every ${plan.intervalCount === 1 ? "" : `${plan.intervalCount} `}${plan.interval}`
    : "";
  const quoteExpired =
    quote !== null && new Date(quote.expiresAt).getTime() <= now;
  const hosted =
    operation?.status === "requires_action"
      ? (() => {
          try {
            return billingHostedUrl(operation.action.url);
          } catch {
            // error-policy:J3 reject invalid provider navigation without opening a fallback destination.
            return null;
          }
        })()
      : null;
  return (
    <section aria-label="App subscription" className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {catalog.appName} subscription
        </h1>
        <p className="text-muted-foreground">
          {snapshot.account.displayName} · {props.productFamilyKey}
        </p>
        <p>
          Your subscription and trial apply to {catalog.appName}. An Eliza
          subscription is not required.
        </p>
        {catalog.environment === "test" && (
          <p role="status" className="text-orange-600">
            Test environment · No live app access or live charges
          </p>
        )}
      </header>
      {error && (
        <div role="alert" className="space-y-2">
          <p>{error}</p>
          <Button
            size="touch"
            variant="outline"
            disabled={busy}
            onClick={() => void (pending ? billing.retry() : billing.refresh())}
          >
            Retry billing request
          </Button>
        </div>
      )}
      <Card
        role="region"
        aria-label="Current access"
        variant="outlinedPadded"
        stack="compact"
      >
        <h2 className="text-lg font-medium">Current access</h2>
        <p>
          {expired
            ? "Access needs to be refreshed"
            : snapshot.entitlement?.access === "granted"
              ? "Access active"
              : snapshot.entitlement?.access === "read_only"
                ? "Read-only access · New activity is unavailable"
                : snapshot.entitlement?.access === "denied"
                  ? "Access ended · Choose a plan to continue"
                  : "No subscription"}
        </p>
        {snapshot.subscription && (
          <>
            <p>
              Subscription: {snapshot.subscription.status.replaceAll("_", " ")}
            </p>
            <p>
              {snapshot.subscription.quantity} seats · Period ends{" "}
              {date(snapshot.subscription.currentPeriodEnd)}
            </p>
            {snapshot.subscription.trial && (
              <p>Trial ends {date(snapshot.subscription.trial.endsAt)}</p>
            )}
            {snapshot.subscription.cancelAtPeriodEnd && (
              <p>Your subscription ends at the end of this period.</p>
            )}
          </>
        )}
        {snapshot.entitlement && (
          <p>
            {snapshot.entitlement.assignedSeats} of{" "}
            {snapshot.entitlement.seatCapacity} seats assigned
          </p>
        )}
        {snapshot.allowances.map((allowance) => (
          <p key={`${allowance.source}:${allowance.expiresAt}`}>
            {allowance.source === "trial" ? "Trial" : "Paid"} allowance: $
            {allowance.remainingUsd} remaining · Expires{" "}
            {date(allowance.expiresAt)}
          </p>
        ))}
        {snapshot.trialEligibility.status === "claimed" && (
          <p>
            Your seven-day trial ends {date(snapshot.trialEligibility.endsAt)}.
            Changing plans does not restart it.
          </p>
        )}
        {!canManage && (
          <p>
            A billing administrator manages this account’s plan, payment method,
            and seats.
          </p>
        )}
        <Button
          size="touch"
          variant="outline"
          disabled={busy}
          onClick={() => void billing.refresh()}
        >
          Refresh subscription
        </Button>
      </Card>
      {operation && (
        <Card
          aria-label="Billing request"
          role="status"
          variant="outlinedPadded"
          stack="compact"
        >
          {operation.status === "pending" && (
            <p>Your request is being processed.</p>
          )}
          {operation.status === "outcome_unknown" && (
            <p>
              The payment result is being checked. Keep this request open; you
              do not need to pay again.
            </p>
          )}
          {operation.status === "succeeded" && (
            <p>
              Your request completed. Access shown above comes from the latest
              subscription.
            </p>
          )}
          {operation.status === "failed" && (
            <>
              <p>{operation.error.message}</p>
              {operation.error.retryable && pending?.intent && (
                <Button
                  size="touch"
                  disabled={busy}
                  onClick={() => void billing.retry()}
                >
                  Retry the same request
                </Button>
              )}
            </>
          )}
          {operation.status === "requires_action" && (
            <>
              <p>
                {operation.action.kind === "checkout"
                  ? "Continue to payment to review and complete this subscription. Returning here alone does not activate access."
                  : operation.action.kind === "payment"
                    ? "Authenticate payment for your confirmed change. Your current plan and seats remain in place until payment succeeds."
                    : "Open your app’s billing portal to manage its payment method and invoices."}
              </p>
              {hosted &&
              (operation.action.expiresAt === null ||
                new Date(operation.action.expiresAt).getTime() > now) ? (
                <Button size="touch" asChild>
                  <a href={hosted} target="_blank" rel="noopener noreferrer">
                    {operation.action.kind === "checkout"
                      ? "Continue to payment"
                      : operation.action.kind === "payment"
                        ? "Authenticate payment"
                        : "Open billing portal"}
                  </a>
                </Button>
              ) : (
                <p role="alert">
                  This payment link is unavailable or expired. Refresh your
                  subscription.
                </p>
              )}
              {operation.action.kind === "portal" ? (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void billing.dismissPortal()}
                >
                  Done with portal · Refresh
                </Button>
              ) : operation.action.kind === "payment" ? (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void billing.retry()}
                >
                  Check payment status
                </Button>
              ) : (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void billing.submit(
                      {
                        kind: "expire",
                        request: { ...command(), operationId: operation.id },
                      },
                      true,
                    )
                  }
                >
                  Cancel this checkout
                </Button>
              )}
            </>
          )}
        </Card>
      )}
      {plan ? (
        <Card
          role="region"
          aria-label="Plan selection"
          variant="outlinedPadded"
          stack="default"
        >
          <h2 className="text-lg font-medium">Choose your plan</h2>
          <label htmlFor={`${inputId}-plan`} className="block space-y-2">
            <span>Plan</span>
            <NativeSelect
              id={`${inputId}-plan`}
              value={plan.id}
              disabled={disabled}
              onChange={(event) => {
                setPlanId(event.target.value);
                billing.setQuote(null);
                setConfirmation(null);
              }}
            >
              {plans?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <p>{terms}</p>
          <p>
            {plan.trial.days}-day trial · No payment method required · $
            {plan.trial.allowanceUsd} trial allowance
          </p>
          <p>
            Includes ${plan.allowanceUsd} per billing period. After access ends:{" "}
            {plan.expiredAccess === "read_only"
              ? "read-only access"
              : "access is unavailable"}
            .
          </p>
          {plan.featureKeys.length > 0 && (
            <ul className="list-disc pl-5">
              {plan.featureKeys.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          )}
          <label htmlFor={`${inputId}-quantity`} className="block space-y-2">
            <span>
              Seats ({plan.seats.minimum}–{plan.seats.maximum})
            </span>
            <Input
              id={`${inputId}-quantity`}
              type="number"
              min={plan.seats.minimum}
              max={plan.seats.maximum}
              step={1}
              value={Number.isNaN(quantity) ? "" : quantity}
              disabled={disabled}
              onChange={(event) => {
                setQuantity(event.target.valueAsNumber);
                billing.setQuote(null);
                setConfirmation(null);
              }}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            {snapshot.trialEligibility.status === "eligible" &&
              snapshot.mutationRevision === null && (
                <Button
                  size="touch"
                  disabled={disabled || !selectedValid}
                  onClick={() =>
                    void billing.submit({
                      kind: "trial",
                      request: {
                        ...command(),
                        planRevisionId: plan.id,
                        quantity,
                      },
                    })
                  }
                >
                  Start seven-day trial
                </Button>
              )}
            <Button
              size="touch"
              disabled={disabled || !selectedValid}
              onClick={() => {
                if (snapshot.mutationRevision === null)
                  setConfirmation("checkout");
                else void billing.getQuote(plan.id, quantity);
              }}
            >
              {snapshot.mutationRevision === null
                ? "Review subscription"
                : "Review plan and seats"}
            </Button>
          </div>
          {confirmation === "checkout" && (
            <Card asChild variant="topDivider" className="pt-4 space-y-3">
              <fieldset aria-label="Confirm subscription">
                <p>
                  Subscribe to {plan.name} for {quantity} seats at {terms}.
                  Review the full total and any taxes on the payment page before
                  paying.
                </p>
                <Button
                  size="touch"
                  disabled={disabled || !selectedValid}
                  onClick={() => {
                    setConfirmation(null);
                    void billing.submit({
                      kind: "checkout",
                      request: {
                        ...command(),
                        planRevisionId: plan.id,
                        quantity,
                        billingConsent: "accepted",
                      },
                    });
                  }}
                >
                  Agree and continue to payment
                </Button>
                <Button
                  size="touch"
                  variant="ghost"
                  onClick={() => setConfirmation(null)}
                >
                  Back
                </Button>
              </fieldset>
            </Card>
          )}
          {quote && (
            <Card asChild variant="topDivider" className="pt-4 space-y-3">
              <fieldset aria-label="Confirm plan change">
                <p>Due now: {money(quote.dueNowCents, quote.currency)}</p>
                <p>
                  Recurring total:{" "}
                  {money(quote.recurringAmountCents, quote.currency)} · Next
                  invoice: {money(quote.nextInvoiceAmountCents, quote.currency)}
                </p>
                {quote.trialEndsAt && (
                  <p>Trial still ends {date(quote.trialEndsAt)}</p>
                )}
                <p>
                  {quoteExpired
                    ? "This quote expired. Review again for a current total."
                    : `Quote valid until ${date(quote.expiresAt)}`}
                </p>
                <Button
                  size="touch"
                  disabled={disabled || quoteExpired}
                  onClick={() =>
                    void billing.submit({
                      kind: "update",
                      request: {
                        idempotencyKey: crypto.randomUUID(),
                        expectedSubscriptionRevision:
                          quote.subscriptionRevision,
                        quoteId: quote.id,
                        planRevisionId: quote.planRevisionId,
                        quantity: quote.quantity,
                        billingConsent: "accepted",
                      },
                    })
                  }
                >
                  Confirm plan change
                </Button>
                <Button
                  size="touch"
                  variant="ghost"
                  onClick={() => billing.setQuote(null)}
                >
                  Back
                </Button>
              </fieldset>
            </Card>
          )}
        </Card>
      ) : (
        <p>No published plans are available for this subscription.</p>
      )}
      {snapshot.subscription && canManage && (
        <section aria-label="Manage subscription" className="space-y-3">
          <h2 className="text-lg font-medium">Manage subscription</h2>
          <div className="flex flex-wrap gap-3">
            <Button
              size="touch"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                void billing.submit({ kind: "portal", request: command() })
              }
            >
              Payment methods and invoices
            </Button>
            {snapshot.mutationRevision !== null && (
              <Button
                size="touch"
                variant="outline"
                disabled={disabled}
                onClick={() => setConfirmation("cancel")}
              >
                Cancel subscription
              </Button>
            )}
          </div>
          {confirmation === "cancel" && (
            <fieldset aria-label="Confirm cancellation" className="space-y-3">
              <p>
                Choose when this app subscription ends. Other apps and your
                Eliza account stay separate.
              </p>
              <Button
                size="touch"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setConfirmation(null);
                  void billing.submit({
                    kind: "cancel",
                    request: { ...command(), timing: "period_end" },
                  });
                }}
              >
                Cancel at period end
              </Button>
              <Button
                size="touch"
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  setConfirmation(null);
                  void billing.submit({
                    kind: "cancel",
                    request: { ...command(), timing: "immediate" },
                  });
                }}
              >
                End access immediately
              </Button>
              <Button
                size="touch"
                variant="ghost"
                onClick={() => setConfirmation(null)}
              >
                Keep subscription
              </Button>
            </fieldset>
          )}
        </section>
      )}
      <AppBillingRecords
        key={JSON.stringify([loaded.scope, snapshot.observedAt])}
        client={props.client}
        accountId={snapshot.account.id}
        productFamilyKey={props.productFamilyKey}
        administrator={canManage}
      />
    </section>
  );
}
