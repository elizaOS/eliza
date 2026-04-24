import { cn, Field, FieldDescription, FieldLabel } from "@elizaos/ui";
import type * as React from "react";

export function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <Field className={cn("gap-1.5", className)} {...props} />;
}

export function SettingsFieldLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldLabel>) {
  return (
    <FieldLabel
      className={cn("text-xs font-semibold text-txt", className)}
      {...props}
    />
  );
}

export function SettingsFieldDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldDescription>) {
  return (
    <FieldDescription
      className={cn("text-xs-tight text-muted", className)}
      {...props}
    />
  );
}

export function AdvancedSettingsDisclosure({
  title = "Advanced",
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cn(
        "group rounded-xl border border-border/60 bg-card/45 px-3 py-2",
        className,
      )}
    >
      <summary className="cursor-pointer select-none list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-txt">
        {title}
      </summary>
      <div className="mt-3 border-t border-border/40 pt-3">{children}</div>
    </details>
  );
}
