import type * as React from "react";
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
declare function FormField({
  label,
  description,
  errors,
  density,
  className,
  children,
  ...props
}: FormFieldProps): import("react/jsx-runtime").JSX.Element;

export { FormField };
//# sourceMappingURL=form-field.d.ts.map
