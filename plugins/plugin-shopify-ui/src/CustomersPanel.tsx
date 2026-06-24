import { formatShortDate, Skeleton } from "@elizaos/ui";
import {
  CalendarDays,
  CircleDollarSign,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { ShopifyCustomer } from "./useShopifyDashboard";

function CustomerRow({ customer }: { customer: ShopifyCustomer }) {
  const fullName =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "—";

  return (
    <div className="flex flex-wrap items-center gap-3 px-2 py-2 transition-colors hover:bg-bg-muted/20">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center text-xs-tight font-semibold uppercase text-muted-strong">
        {(customer.firstName?.[0] ?? customer.email[0] ?? "?").toUpperCase()}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {fullName}
        </div>
        <div className="mt-0.5 truncate text-xs-tight text-muted">
          {customer.email}
        </div>
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-txt"
        title="Orders"
      >
        <ShoppingCart className="h-3.5 w-3.5 text-muted" aria-hidden />
        {customer.ordersCount.toLocaleString()}
      </div>

      <div
        className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-txt"
        title="Total spent"
      >
        <CircleDollarSign className="h-3.5 w-3.5 text-muted" aria-hidden />
        {customer.totalSpent} {customer.currencyCode}
      </div>

      <div
        className="hidden shrink-0 items-center gap-1.5 text-xs-tight text-muted sm:flex"
        title="Joined"
      >
        <CalendarDays className="h-3.5 w-3.5" aria-hidden />
        {formatShortDate(customer.createdAt)}
      </div>
    </div>
  );
}

interface CustomersPanelProps {
  customers: ShopifyCustomer[];
  total: number;
  loading: boolean;
  error: string | null;
  search: string;
}

export function CustomersPanel({
  customers,
  total,
  loading,
  error,
}: CustomersPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p
          data-testid="chat-search-hint"
          className="sr-only text-[13px] leading-relaxed text-txt/60"
        >
          Search customers by typing in the chat.
        </p>
        {!loading ? (
          <span className="shrink-0 text-xs text-muted">
            {total.toLocaleString()} customer{total !== 1 ? "s" : ""}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="px-1 py-2 text-sm text-danger">{error}</div>
      ) : null}

      {loading && customers.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Users className="h-8 w-8 text-muted/40" />
          <div className="text-sm text-muted">None</div>
        </div>
      ) : (
        <div className="space-y-1.5">
          {customers.map((customer) => (
            <CustomerRow key={customer.id} customer={customer} />
          ))}
        </div>
      )}
    </div>
  );
}
