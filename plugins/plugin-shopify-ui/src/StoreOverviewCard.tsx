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
    <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-ok/25 bg-ok/10">
          <Store className="h-5 w-5 text-ok" />
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-bg bg-ok" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold text-txt">
            {shop.name}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-ok/20 bg-ok/10 px-2 py-0.5 text-2xs font-semibold uppercase tracking-[0.1em] text-ok">
              live
            </span>
            <span className="max-w-[12rem] truncate rounded-full border border-border/24 bg-bg/45 px-2 py-0.5 text-xs text-muted">
              {shop.domain}
            </span>
            <span className="rounded-full border border-border/24 bg-bg/45 px-2 py-0.5 text-xs text-muted">
              {shop.currencyCode}
            </span>
          </div>
        </div>
        <div className="rounded-full border border-border/24 bg-bg-accent px-2.5 py-1 text-xs font-medium text-muted-strong">
          {shop.plan}
        </div>
      </div>
    </div>
  );
}
