import { Store } from "lucide-react";

interface StoreShop {
  name: string;
  domain: string;
  plan: string;
  email: string;
  currencyCode: string;
}

interface StoreOverviewCardProps {
  shop: StoreShop;
}

export function StoreOverviewCard({ shop }: StoreOverviewCardProps) {
  return (
    <div className="rounded-2xl bg-card/40 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/24 bg-bg-accent">
          <Store className="h-5 w-5 text-muted-strong" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-txt">
            {shop.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5 font-medium text-ok">
              <span className="h-2 w-2 rounded-full bg-ok" />
              live
            </span>
            <span className="max-w-[12rem] truncate">{shop.domain}</span>
            <span>{shop.currencyCode}</span>
          </div>
        </div>
        <div className="rounded-full bg-bg-accent px-2.5 py-1 text-xs font-medium text-muted-strong">
          {shop.plan}
        </div>
      </div>
    </div>
  );
}
