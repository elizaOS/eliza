/** Lets an app owner browse settled receipts, review current refundable funds, and explicitly submit through the shared durable billing intent flow. */
import type {
  AppBillingAdminClient,
  AppBillingPaidPeriod,
  AppBillingRefundPreview,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import type { CatalogIntent, CatalogScope } from "./app-catalog-intent";

export function AppRefundForm({
  client,
  scope,
  disabled,
  onSubmit,
  onRecover,
}: {
  client: AppBillingAdminClient;
  scope: CatalogScope;
  disabled: boolean;
  onSubmit: (intent: CatalogIntent) => void;
  onRecover: (commandId: string) => void;
}) {
  const [items, setItems] = useState<AppBillingPaidPeriod[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    period: AppBillingPaidPeriod;
    preview: AppBillingRefundPreview;
  } | null>(null);
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  const generation = useRef(0);
  const id = useId();
  const load = useCallback(
    async (cursor: string | null) => {
      const current = ++generation.current;
      setBusy(true);
      setError(null);
      setReady(false);
      if (cursor === null) {
        setSelected(null);
        setConfirm(false);
      }
      try {
        const result = (
          await client.paidPeriods(scope.clientRegistrationId, cursor)
        ).data;
        if (
          result.appId !== scope.appId ||
          result.clientRegistrationId !== scope.clientRegistrationId ||
          result.environment !== scope.environment
        )
          throw new Error(
            "Payment receipts belong to another app or environment. Reopen billing settings.",
          );
        if (current === generation.current) {
          setItems((previous) =>
            cursor === null ? result.items : [...previous, ...result.items],
          );
          setNextCursor(result.nextCursor);
          setReady(true);
        }
      } catch (cause) {
        // error-policy:J4 Receipt read failures disable review and remain visibly distinct from an empty history.
        if (current === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Payment receipts are unavailable.",
          );
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [client, scope.appId, scope.clientRegistrationId, scope.environment],
  );
  useEffect(() => {
    void load(null);
    return () => {
      generation.current++;
    };
  }, [load]);
  const review = async (period: AppBillingPaidPeriod) => {
    const current = ++generation.current;
    setBusy(true);
    setError(null);
    setSelected(null);
    setConfirm(false);
    try {
      const preview = (
        await client.previewRefund({
          clientRegistrationId: scope.clientRegistrationId,
          paidPeriodId: period.id,
        })
      ).data;
      if (
        preview.appId !== scope.appId ||
        preview.clientRegistrationId !== scope.clientRegistrationId ||
        preview.paidPeriodId !== period.id ||
        preview.environment !== scope.environment ||
        preview.accessPolicy !== "preserve"
      )
        throw new Error("Refund preview does not match the selected payment.");
      if (current === generation.current) {
        setSelected({ period, preview });
        setAmount(String(preview.amountAvailableCents));
      }
    } catch (cause) {
      // error-policy:J4 A failed preview never leaves an earlier amount enabled for submission.
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Refund preview is unavailable.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const amountCents = /^[1-9][0-9]*$/.test(amount) ? Number(amount) : NaN;
  const valid =
    selected !== null &&
    Number.isSafeInteger(amountCents) &&
    amountCents <= selected.preview.amountAvailableCents;
  const money = (value: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
      value / 100,
    );
  return (
    <Card
      variant="insetPadded"
      stack="default"
      role="region"
      aria-label="Payment refunds"
    >
      <h3 className="font-semibold">Payment refunds</h3>
      <p>
        Refund an original payment while keeping subscription access and renewal
        unchanged. Cloud credits and consumed allowance are not replenished.
      </p>
      {error && <p role="alert">{error}</p>}
      {!ready && !error && <p role="status">Loading payment receipts…</p>}
      <Button
        size="touch"
        variant="outline"
        disabled={busy}
        onClick={() => void load(null)}
      >
        Refresh payments
      </Button>
      {ready && items.length === 0 && (
        <p>No settled payments in this environment.</p>
      )}
      {items.map((period) => (
        <Card key={period.id} variant="insetPadded" stack="compact">
          <p>
            {period.accountName} · {period.planName}
          </p>
          <p>
            {new Date(period.periodStart).toLocaleDateString()}–
            {new Date(period.periodEnd).toLocaleDateString()}
          </p>
          <Button
            size="touch"
            variant="outline"
            disabled={disabled || busy || !ready}
            onClick={() => void review(period)}
          >
            Review payment
          </Button>
          {period.refundOperations.map((operation) => (
            <div key={operation.id} className="space-y-2">
              <p>
                Refund requested{" "}
                {new Date(operation.createdAt).toLocaleString()} ·{" "}
                {operation.state.replaceAll("_", " ")}
              </p>
              {operation.state !== "failed" && (
                <Button
                  size="touch"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onRecover(operation.id)}
                >
                  View refund status
                </Button>
              )}
            </div>
          ))}
        </Card>
      ))}
      {nextCursor !== null && (
        <Button
          size="touch"
          variant="outline"
          disabled={busy || !ready}
          onClick={() => void load(nextCursor)}
        >
          More payments
        </Button>
      )}
      {selected && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !disabled && !busy) setConfirm(true);
          }}
        >
          <h4 className="font-semibold">
            Refund {selected.period.accountName}
          </h4>
          <p>
            Original payment:{" "}
            {money(selected.preview.amountPaidCents, selected.preview.currency)}
            . Available to refund:{" "}
            {money(
              selected.preview.amountAvailableCents,
              selected.preview.currency,
            )}
            .
          </p>
          <label htmlFor={`${id}-amount`}>
            Refund amount in {selected.preview.currency.toUpperCase()} cents
          </label>
          <Input
            id={`${id}-amount`}
            inputMode="numeric"
            value={amount}
            disabled={disabled || busy}
            onChange={(event) => {
              setAmount(event.target.value);
              setConfirm(false);
            }}
          />
          {!valid && (
            <p role="status">
              {selected.preview.amountAvailableCents === 0
                ? "This payment has no funds remaining to refund."
                : "Enter a positive whole number of cents within the available refund amount."}
            </p>
          )}
          <Button
            size="touch"
            type="submit"
            disabled={!valid || disabled || busy}
          >
            Review refund
          </Button>
          {confirm && valid && (
            <Card
              variant="insetPadded"
              stack="compact"
              role="group"
              aria-label="Confirm refund"
            >
              <p>
                Refund {money(amountCents, selected.preview.currency)} to the
                original payment method for {selected.period.accountName}.
                Subscription access and future renewal remain unchanged.
              </p>
              <Button
                size="touch"
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  if (valid && !disabled && !busy)
                    onSubmit({
                      kind: "refund",
                      request: {
                        clientRegistrationId: scope.clientRegistrationId,
                        paidPeriodId: selected.period.id,
                        idempotencyKey: crypto.randomUUID(),
                        amountCents,
                        accessPolicy: "preserve",
                        confirmation: "refund_original_payment_preserve_access",
                      },
                    });
                }}
              >
                Confirm refund and keep access
              </Button>
              <Button
                size="touch"
                type="button"
                variant="ghost"
                onClick={() => setConfirm(false)}
              >
                Back
              </Button>
            </Card>
          )}
        </form>
      )}
    </Card>
  );
}
