import { formatShortDate, SegmentedControl, Skeleton } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { ChevronDown, ChevronUp, ShoppingCart } from "lucide-react";
import { useState } from "react";
import type { ShopifyOrder } from "./useShopifyDashboard";

function FulfillmentBadge({
  status,
}: {
  status: ShopifyOrder["fulfillmentStatus"];
}) {
  if (!status) return null;

  const styles = {
    FULFILLED: "bg-ok",
    UNFULFILLED: "bg-warn",
    PARTIALLY_FULFILLED: "bg-warn",
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
      role="img"
      aria-label={labels[status]}
      title={labels[status]}
      className={`inline-flex h-2.5 w-2.5 rounded-full ${styles[status]}`}
    />
  );
}

function FinancialBadge({
  status,
}: {
  status: ShopifyOrder["financialStatus"];
}) {
  const styles = {
    PAID: "bg-ok",
    PENDING: "bg-warn",
    REFUNDED: "bg-danger",
    PARTIALLY_REFUNDED: "bg-danger",
  } satisfies Record<ShopifyOrder["financialStatus"], string>;

  const labels: Record<ShopifyOrder["financialStatus"], string> = {
    PAID: "Paid",
    PENDING: "Pending",
    REFUNDED: "Refunded",
    PARTIALLY_REFUNDED: "Partial refund",
  };

  return (
    <span
      role="img"
      aria-label={labels[status]}
      title={labels[status]}
      className={`inline-flex h-2.5 w-2.5 rounded-full ${styles[status]}`}
    />
  );
}

function OrderRow({ order }: { order: ShopifyOrder }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useAgentElement<HTMLButtonElement>({
    id: `order-toggle-${order.id}`,
    role: "button",
    label: `Order ${order.name} details`,
    group: "orders",
    status: expanded ? "active" : "inactive",
    description: `Expand or collapse details for order ${order.name}`,
    onActivate: () => setExpanded((prev) => !prev),
  });

  return (
    <div className="rounded-xl">
      <button
        ref={toggle.ref}
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-card/40 rounded-xl"
        {...toggle.agentProps}
      >
        <div className="min-w-[4rem] shrink-0">
          <div className="text-sm font-semibold text-txt">{order.name}</div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {order.lineItemCount} item{order.lineItemCount !== 1 ? "s" : ""}
          </div>
        </div>

        <div className="min-w-0 flex-1 truncate text-xs text-muted">
          {order.email || "—"}
        </div>

        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold text-txt">
            {order.totalPrice} {order.currencyCode}
          </div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {formatShortDate(order.createdAt)}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1.5">
          <FulfillmentBadge status={order.fulfillmentStatus} />
          <FinancialBadge status={order.financialStatus} />
        </div>

        <div className="shrink-0 text-muted">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded ? (
        <div className="px-3 pb-3">
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted">Order ID</dt>
            <dd className="font-semibold text-txt break-all">{order.id}</dd>
            <dt className="text-muted">Customer</dt>
            <dd className="font-semibold text-txt">{order.email || "—"}</dd>
            <dt className="text-muted">Total</dt>
            <dd className="font-semibold text-txt">
              {order.totalPrice} {order.currencyCode}
            </dd>
            <dt className="text-muted">Fulfillment</dt>
            <dd>
              <FulfillmentBadge status={order.fulfillmentStatus} />
            </dd>
            <dt className="text-muted">Payment</dt>
            <dd>
              <FinancialBadge status={order.financialStatus} />
            </dd>
            <dt className="text-muted">Created</dt>
            <dd className="font-semibold text-txt">
              {formatShortDate(order.createdAt)}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

type OrderTab = "any" | "unfulfilled" | "fulfilled";

const ORDER_TABS = [
  { value: "any" as const, label: "All" },
  { value: "unfulfilled" as const, label: "Unfulfilled" },
  { value: "fulfilled" as const, label: "Fulfilled" },
];

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

  const statusFilterControl = useAgentElement<HTMLDivElement>({
    id: "select-order-status",
    role: "select",
    label: "Order status filter",
    group: "orders",
    description: "Filter orders by fulfillment status",
    options: ORDER_TABS.map((t) => t.value),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div ref={statusFilterControl.ref} {...statusFilterControl.agentProps}>
          <SegmentedControl
            value={activeTab}
            onValueChange={(v) => onStatusFilterChange(v)}
            items={ORDER_TABS}
          />
        </div>
        {!loading ? (
          <span className="text-xs text-muted">
            {total.toLocaleString()} order{total !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

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
