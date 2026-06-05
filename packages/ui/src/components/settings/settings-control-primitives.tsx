import type * as React from "react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel } from "../ui/field";

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
  lazy = false,
  defaultOpen = false,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  lazy?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shouldRenderChildren = !lazy || open;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={cn(
        "group rounded-sm border border-border/60 bg-card/45 px-3 py-2",
        className,
      )}
    >
      <summary className="cursor-pointer select-none list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-txt">
        {title}
      </summary>
      {shouldRenderChildren ? (
        <div className="mt-3 border-t border-border/40 pt-3">{children}</div>
      ) : null}
    </details>
  );
}
