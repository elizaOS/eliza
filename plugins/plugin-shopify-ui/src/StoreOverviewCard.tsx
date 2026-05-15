import { Package, ShoppingCart, Store, Users } from "lucide-react";
import type { ShopifyAggregateCounts } from "./useShopifyDashboard";

interface StoreShop {
  name: string;
  domain: string;
  plan: string;
  email: string;
  currencyCode: string;
}

interface StoreOverviewCardProps {
  shop: StoreShop;
  counts: ShopifyAggregateCounts;
}

export function StoreOverviewCard({ shop, counts }: StoreOverviewCardProps) {
  return (
    <div className="rounded-2xl border border-border/30 bg-card/40 px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/30 bg-bg-accent">
          <Store className="h-5 w-5 text-muted-strong" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-txt">
            {shop.name}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{shop.domain}</span>
            <span>·</span>
            <span>{shop.plan}</span>
            <span>·</span>
            <span>{shop.currencyCode}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div
          className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
          title="Products"
        >
          <span className="sr-only">
            {counts.productCount.toLocaleString()} products
          </span>
          <Package className="h-3.5 w-3.5 text-muted/70" aria-hidden />
          <div className="mt-1.5 text-lg font-semibold text-txt">
            {counts.productCount.toLocaleString()}
          </div>
        </div>
        <div
          className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
          title="Orders"
        >
          <span className="sr-only">
            {counts.orderCount.toLocaleString()} orders
          </span>
          <ShoppingCart className="h-3.5 w-3.5 text-muted/70" aria-hidden />
          <div className="mt-1.5 text-lg font-semibold text-txt">
            {counts.orderCount.toLocaleString()}
          </div>
        </div>
        <div
          className="rounded-xl border border-border/24 bg-card/35 px-3 py-3"
          title="Customers"
        >
          <span className="sr-only">
            {counts.customerCount.toLocaleString()} customers
          </span>
          <Users className="h-3.5 w-3.5 text-muted/70" aria-hidden />
          <div className="mt-1.5 text-lg font-semibold text-txt">
            {counts.customerCount.toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  );
}
