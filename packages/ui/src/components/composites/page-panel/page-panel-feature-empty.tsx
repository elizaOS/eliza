import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { PagePanelRoot } from "./page-panel-root";
import type { PagePanelVariant } from "./page-panel-types";

export interface PagePanelFeatureEmptyItem {
  id: string;
  label: ReactNode;
  icon: ComponentType<{ className?: string }>;
  tone?: string;
}

export interface PagePanelFeatureEmptyProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  icon: ComponentType<{ className?: string }>;
  iconTone?: string;
  features?: ReadonlyArray<PagePanelFeatureEmptyItem>;
  variant?: Extract<PagePanelVariant, "surface" | "section" | "inset">;
}

export function PagePanelFeatureEmpty({
  className,
  description,
  features = [],
  icon: Icon,
  iconTone = "border-info/25 bg-info/12 text-info",
  title,
  variant = "surface",
  ...props
}: PagePanelFeatureEmptyProps) {
  return (
    <PagePanelRoot
      variant={variant}
      className={cn(
        "grid min-h-[20rem] place-items-center px-5 py-8",
        className,
      )}
      {...props}
    >
      <div className="w-full max-w-2xl text-center">
        <div
          className={cn(
            "mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border",
            iconTone,
          )}
        >
          <Icon className="h-7 w-7" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-txt">{title}</h2>
        {description ? (
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            {description}
          </p>
        ) : null}
        {features.length > 0 ? (
          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {features.map((item) => {
              const FeatureIcon = item.icon;
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-border/24 bg-bg/45 px-3 py-3"
                >
                  <FeatureIcon
                    className={cn("mx-auto h-4 w-4", item.tone ?? "text-muted")}
                  />
                  <div className="mt-2 text-xs font-semibold text-muted">
                    {item.label}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </PagePanelRoot>
  );
}
