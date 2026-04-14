

import * as React from "react";
import { Field, FieldDescription, FieldLabel, cn } from "@elizaos/ui";

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
