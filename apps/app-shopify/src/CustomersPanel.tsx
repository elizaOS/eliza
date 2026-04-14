/**
 * CustomersPanel — searchable customer table with name, email, order count,
 * total spent, and join date.
 */

import { Input, Skeleton } from "@elizaos/app-core";
import { Search, Users } from "lucide-react";
import { formatShortDate } from "@elizaos/app-core";
import type { ShopifyCustomer } from "./useShopifyDashboard";

// ── Customer row ──────────────────────────────────────────────────────────

function CustomerRow({ customer }: { customer: ShopifyCustomer }) {
  const fullName =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "—";

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/20 bg-card/30 px-3 py-3 transition-colors hover:bg-card/50">
      {/* Avatar initials */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/30 bg-bg-accent text-xs-tight font-semibold uppercase text-muted-strong">
        {(customer.firstName?.[0] ?? customer.email[0] ?? "?").toUpperCase()}
      </div>

      {/* Name + email */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-txt">
          {fullName}
        </div>
        <div className="mt-0.5 truncate text-xs-tight text-muted">
          {customer.email}
        </div>
      </div>

      {/* Orders count */}
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-txt">
          {customer.ordersCount.toLocaleString()}
        </div>
        <div className="mt-0.5 text-2xs text-muted">orders</div>
      </div>

      {/* Total spent */}
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-txt">
          {customer.totalSpent} {customer.currencyCode}
        </div>
        <div className="mt-0.5 text-2xs text-muted">spent</div>
      </div>

      {/* Join date */}
      <div className="hidden shrink-0 text-right sm:block">
        <div className="text-xs-tight text-muted">
          Joined {formatShortDate(customer.createdAt)}
        </div>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────

interface CustomersPanelProps {
  customers: ShopifyCustomer[];
  total: number;
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (q: string) => void;
}

export function CustomersPanel({
  customers,
  total,
  loading,
  error,
  search,
  onSearchChange,
}: CustomersPanelProps) {
  return (
    <div className="space-y-3">
      {/* Search + count */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted/60" />
          <Input
            placeholder="Search customers by name or email…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8"
          />
        </div>
        {!loading ? (
          <span className="shrink-0 text-xs text-muted">
            {total.toLocaleString()} customer{total !== 1 ? "s" : ""}
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
      {loading && customers.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => i).map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/20 bg-card/20 py-12 text-center">
          <Users className="h-8 w-8 text-muted/40" />
          <div className="text-sm text-muted">
            {search ? "No customers match your search." : "No customers found."}
          </div>
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
