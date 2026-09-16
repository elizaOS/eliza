/**
 * Empty-state for a feature page: a lead icon, title, and description over a
 * list of feature bullets (each with its own icon). Shown when a feature has
 * no data yet, to preview what it will offer.
 */
import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { Card } from "../../ui/card";
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
  children,
  className,
  description,
  features = [],
  icon: Icon,
  iconTone = "bg-bg-hover text-muted",
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
        <Card
          asChild
          variant="transparent"
          className={cn(
            // Borderless icon plate (#10710): tint alone carries the shape.
            "mx-auto flex size-14 items-center justify-center",
            iconTone,
          )}
        >
          <div>
            <Icon className="size-7" />
          </div>
        </Card>
        <h2 className="mt-4 text-balance text-base font-semibold text-txt">
          {title}
        </h2>
        {description ? (
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-pretty text-muted">
            {description}
          </p>
        ) : null}
        {features.length > 0 ? (
          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2.5">
            {features.map((item) => {
              const FeatureIcon = item.icon;
              return (
                <div
                  key={item.id}
                  className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted"
                >
                  <FeatureIcon
                    className={cn("size-4", item.tone ?? "text-muted")}
                  />
                  <span>{item.label}</span>
                </div>
              );
            })}
          </div>
        ) : null}
        {children ? <div className="mt-5">{children}</div> : null}
      </div>
    </PagePanelRoot>
  );
}
