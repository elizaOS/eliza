import type * as React from "react";
import { cn } from "../../../lib/utils";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldMessage,
} from "../../ui/field";

export interface FormFieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Label text shown above the field. */
  label?: React.ReactNode;
  /** Optional description below the label. */
  description?: React.ReactNode;
  /** Validation error messages. */
  errors?: readonly string[];
  /** Density controls spacing and text size. */
  density?: "default" | "compact" | "relaxed";
}

function FormField({
  label,
  description,
  errors,
  density = "default",
  className,
  children,
  ...props
}: FormFieldProps) {
  const isCompact = density === "compact";
  return (
    <Field
      className={cn(isCompact ? "gap-1.5" : "space-y-2", className)}
      {...props}
    >
      {label && (
        <FieldLabel
          className={cn(isCompact && "text-xs font-semibold text-txt")}
        >
          {label}
        </FieldLabel>
      )}
      {description && (
        <FieldDescription
          className={cn(isCompact && "text-xs-tight text-muted")}
        >
          {description}
        </FieldDescription>
      )}
      {children}
      {errors?.map((err) => (
        <FieldMessage key={err} tone="danger">
          {err}
        </FieldMessage>
      ))}
    </Field>
  );
}

export { FormField };
