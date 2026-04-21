/**
 * OrdersPanel — tabbed order list (All / Unfulfilled / Fulfilled) with
 * expandable rows showing line item counts, financial status, and dates.
 */

import { SegmentedControl, Skeleton } from "@elizaos/app-core";
import { ChevronDown, ChevronUp, ShoppingCart } from "lucide-react";
import { useState } from "react";
import { formatShortDate } from "@elizaos/app-core";
import type { ShopifyOrder } from "./useShopifyDashboard";

// ── Status badges ─────────────────────────────────────────────────────────

function FulfillmentBadge({
  status,
}: {
  status: ShopifyOrder["fulfillmentStatus"];
}) {
  if (!status) return null;

  const styles = {
    FULFILLED: "bg-ok/15 text-ok border border-ok/20",
    UNFULFILLED: "bg-warn/15 text-warn border border-warn/20",
    PARTIALLY_FULFILLED: "bg-warn/15 text-warn border border-warn/20",
  } satisfies Record<NonNullable<ShopifyOrder["fulfillmentStatus"]>, string>;

  const labels: Record<
    NonNullable<ShopifyOrder["fulfillmentStatus"]>,
    string
  > = {
    FULFILLED: "Fulfilled",
    UNFULFILLED: "Unfulfilled",
    PARTIALLY_FULFILLED: "Partial",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function FinancialBadge({
  status,
}: {
  status: ShopifyOrder["financialStatus"];
}) {
  const styles = {
    PAID: "bg-ok/15 text-ok border border-ok/20",
    PENDING: "bg-warn/15 text-warn border border-warn/20",
    REFUNDED: "bg-danger/15 text-danger border border-danger/20",
    PARTIALLY_REFUNDED: "bg-danger/15 text-danger border border-danger/20",
  } satisfies Record<ShopifyOrder["financialStatus"], string>;

  const labels: Record<ShopifyOrder["financialStatus"], string> = {
    PAID: "Paid",
    PENDING: "Pending",
    REFUNDED: "Refunded",
    PARTIALLY_REFUNDED: "Partial refund",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

// ── Order row ─────────────────────────────────────────────────────────────

function OrderRow({ order }: { order: ShopifyOrder }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border/20 bg-card/30">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-card/50 rounded-xl"
      >
        {/* Order name */}
        <div className="min-w-[4rem] shrink-0">
          <div className="text-sm font-semibold text-txt">{order.name}</div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {order.lineItemCount} item{order.lineItemCount !== 1 ? "s" : ""}
          </div>
        </div>

        {/* Customer email */}
        <div className="min-w-0 flex-1 truncate text-xs text-muted">
          {order.email || "—"}
        </div>

        {/* Total */}
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-txt">
            {order.totalPrice} {order.currencyCode}
          </div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {formatShortDate(order.createdAt)}
          </div>
        </div>

        {/* Badges */}
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <FulfillmentBadge status={order.fulfillmentStatus} />
          <FinancialBadge status={order.financialStatus} />
        </div>

        {/* Expand toggle */}
        <div className="shrink-0 text-muted">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border/20 px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Order ID
              </div>
              <div className="mt-1 text-xs font-semibold text-txt break-all">
                {order.id}
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Customer
              </div>
              <div className="mt-1 text-xs font-semibold text-txt">
                {order.email || "—"}
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Total
              </div>
              <div className="mt-1 text-xs font-semibold text-txt">
                {order.totalPrice} {order.currencyCode}
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Fulfillment
              </div>
              <div className="mt-1.5">
                <FulfillmentBadge status={order.fulfillmentStatus} />
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Payment
              </div>
              <div className="mt-1.5">
                <FinancialBadge status={order.financialStatus} />
              </div>
            </div>
            <div className="rounded-lg border border-border/20 bg-card/35 px-3 py-2.5">
              <div className="text-2xs uppercase tracking-[0.12em] text-muted/70">
                Created
              </div>
              <div className="mt-1 text-xs font-semibold text-txt">
                {formatShortDate(order.createdAt)}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Tab items ─────────────────────────────────────────────────────────────

type OrderTab = "any" | "unfulfilled" | "fulfilled";

const ORDER_TABS = [
  { value: "any" as const, label: "All" },
  { value: "unfulfilled" as const, label: "Unfulfilled" },
  { value: "fulfilled" as const, label: "Fulfilled" },
];

// ── Panel ─────────────────────────────────────────────────────────────────

interface OrdersPanelProps {
  orders: ShopifyOrder[];
  total: number;
  loading: boolean;
  error: string | null;
  statusFilter: string;
  onStatusFilterChange: (status: string) => void;
}

export function OrdersPanel({
  orders,
  total,
  loading,
  error,
  statusFilter,
  onStatusFilterChange,
}: OrdersPanelProps) {
  const activeTab = (
    ORDER_TABS.some((t) => t.value === statusFilter) ? statusFilter : "any"
  ) as OrderTab;

  return (
    <div className="space-y-3">
      {/* Filter tabs */}
      <div className="flex items-center justify-between gap-3">
        <SegmentedControl
          value={activeTab}
          onValueChange={(v) => onStatusFilterChange(v)}
          items={ORDER_TABS}
        />
        {!loading ? (
          <span className="text-xs text-muted">
            {total.toLocaleString()} order{total !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>

      {/* Error */}
      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {/* Loading skeletons */}
      {loading && orders.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/20 bg-card/20 py-12 text-center">
          <ShoppingCart className="h-8 w-8 text-muted/40" />
          <div className="text-sm text-muted">
            {activeTab === "unfulfilled"
              ? "No unfulfilled orders."
              : activeTab === "fulfilled"
                ? "No fulfilled orders."
                : "No orders found."}
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </div>
      )}
    </div>
  );
}
