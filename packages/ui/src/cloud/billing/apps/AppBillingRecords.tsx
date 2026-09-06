/** Displays server-owned app seats, invoices, and usage with explicit pagination and separate loading/error states. */
import type {
  AppBillingClient,
  AppBillingInvoice,
  AppBillingPage,
  AppBillingSeat,
  AppBillingUsage,
} from "@elizaos/cloud-sdk/app-billing";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { SemanticForm } from "../../../components/ui/semantic-form";
import { billingHostedUrl } from "./billing-intent";

export interface AppBillingRecordsProps {
  client: AppBillingClient;
  accountId: string;
  productFamilyKey: string;
  administrator: boolean;
}
export function AppBillingRecords({
  client,
  accountId,
  productFamilyKey,
  administrator,
}: AppBillingRecordsProps) {
  const [seats, setSeats] = useState<AppBillingPage<AppBillingSeat> | null>(
    null,
  );
  const [invoices, setInvoices] =
    useState<AppBillingPage<AppBillingInvoice> | null>(null);
  const [usage, setUsage] = useState<AppBillingPage<AppBillingUsage> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [subject, setSubject] = useState("");
  const [seatIntent, setSeatIntent] = useState<{
    subject: string;
    key: string;
  } | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const inputId = useId();
  const read = useCallback(async () => {
    const [seatResult, invoiceResult, usageResult] = await Promise.all([
      client.listSeats(accountId, productFamilyKey),
      client.listInvoices(accountId, productFamilyKey),
      client.listUsage(accountId, productFamilyKey),
    ]);
    if (!alive.current) return;
    setSeats(seatResult.data);
    setInvoices(invoiceResult.data);
    setUsage(usageResult.data);
  }, [client, accountId, productFamilyKey]);
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 show record/membership transport failures without inventing an empty result.
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Billing records are unavailable",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void perform(read);
    return () => {
      alive.current = false;
    };
  }, [read, perform]);
  return (
    <Card
      role="region"
      aria-label="Billing records"
      variant="outlinedPadded"
      className="space-y-5"
    >
      <h2 className="text-lg font-medium">Seats, invoices, and usage</h2>
      {error && <p role="alert">{error}</p>}
      <Button
        size="touch"
        variant="outline"
        disabled={busy}
        onClick={() => void perform(read)}
      >
        Refresh records
      </Button>
      {!seats || !invoices || !usage ? (
        <p role="status">
          {error ? "Records could not be loaded." : "Loading billing records…"}
        </p>
      ) : (
        <>
          <section aria-label="Assigned seats" className="space-y-3">
            <h3 className="font-medium">Assigned seats</h3>
            {seats.items.length === 0 ? (
              <p>No seats assigned.</p>
            ) : (
              <ul className="space-y-2">
                {seats.items.map((seat) => (
                  <li
                    key={seat.id}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <span>{seat.subject}</span>
                    {administrator && (
                      <Button
                        size="touch"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await client.revokeSeat(
                              accountId,
                              productFamilyKey,
                              seat.id,
                              crypto.randomUUID(),
                            );
                            await read();
                          })
                        }
                      >
                        Revoke seat for {seat.subject}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {seats.nextCursor !== null && (
              <Button
                size="touch"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = (
                      await client.listSeats(
                        accountId,
                        productFamilyKey,
                        seats.nextCursor ?? undefined,
                      )
                    ).data;
                    setSeats({
                      items: [...seats.items, ...next.items],
                      nextCursor: next.nextCursor,
                    });
                  })
                }
              >
                Load more seats
              </Button>
            )}
            {administrator && (
              <SemanticForm
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const intent = seatIntent ?? {
                    subject,
                    key: crypto.randomUUID(),
                  };
                  setSeatIntent(intent);
                  void perform(async () => {
                    await client.assignSeat(accountId, productFamilyKey, {
                      subject: intent.subject,
                      idempotencyKey: intent.key,
                    });
                    setSeatIntent(null);
                    setSubject("");
                    await read();
                  });
                }}
              >
                <label htmlFor={inputId}>App member identifier</label>
                <Input
                  id={inputId}
                  value={seatIntent?.subject ?? subject}
                  disabled={busy || seatIntent !== null}
                  required
                  onChange={(event) => setSubject(event.target.value)}
                />
                <Button
                  size="touch"
                  type="submit"
                  disabled={busy || subject.trim().length === 0}
                >
                  {seatIntent ? "Retry seat assignment" : "Assign seat"}
                </Button>
              </SemanticForm>
            )}
          </section>
          <section aria-label="Invoices" className="space-y-3">
            <h3 className="font-medium">Invoices</h3>
            {invoices.items.length === 0 ? (
              <p>No invoices yet.</p>
            ) : (
              <ul className="space-y-3">
                {invoices.items.map((invoice) => (
                  <li key={invoice.id}>
                    {new Date(invoice.periodStart).toLocaleDateString()} ·{" "}
                    {invoice.status} ·{" "}
                    {new Intl.NumberFormat(undefined, {
                      style: "currency",
                      currency: invoice.currency,
                    }).format(invoice.amountDueCents / 100)}{" "}
                    due
                    {invoice.hostedInvoiceUrl && (
                      <InvoiceLink url={invoice.hostedInvoiceUrl} />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {invoices.nextCursor !== null && (
              <Button
                size="touch"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = (
                      await client.listInvoices(
                        accountId,
                        productFamilyKey,
                        invoices.nextCursor ?? undefined,
                      )
                    ).data;
                    setInvoices({
                      items: [...invoices.items, ...next.items],
                      nextCursor: next.nextCursor,
                    });
                  })
                }
              >
                Load more invoices
              </Button>
            )}
          </section>
          <section aria-label="Usage" className="space-y-3">
            <h3 className="font-medium">Usage</h3>
            {usage.items.length === 0 ? (
              <p>No usage recorded.</p>
            ) : (
              <ul className="space-y-2">
                {usage.items.map((item) => (
                  <li key={`${item.operationId}:${item.fundingSource}`}>
                    {new Date(item.occurredAt).toLocaleString()} · $
                    {item.amountUsd} ·{" "}
                    {item.fundingSource === "trial"
                      ? "Trial allowance"
                      : "Paid allowance"}
                  </li>
                ))}
              </ul>
            )}
            {usage.nextCursor !== null && (
              <Button
                size="touch"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = (
                      await client.listUsage(
                        accountId,
                        productFamilyKey,
                        usage.nextCursor ?? undefined,
                      )
                    ).data;
                    setUsage({
                      items: [...usage.items, ...next.items],
                      nextCursor: next.nextCursor,
                    });
                  })
                }
              >
                Load more usage
              </Button>
            )}
          </section>
        </>
      )}
    </Card>
  );
}
function InvoiceLink({ url }: { url: string }) {
  try {
    return (
      <Button size="touch" asChild variant="link">
        <a
          href={billingHostedUrl(url)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open invoice
        </a>
      </Button>
    );
  } catch {
    // error-policy:J3 unsafe invoice links remain visibly unavailable.
    return <span> · Invoice link unavailable</span>;
  }
}
