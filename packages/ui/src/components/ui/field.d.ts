import type * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";

declare const Field: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>
>;
declare const FieldLabel: React.ForwardRefExoticComponent<
  Omit<
    LabelPrimitive.LabelProps & React.RefAttributes<HTMLLabelElement>,
    "ref"
  > & {
    variant?: "default" | "form" | "kicker";
  } & React.RefAttributes<HTMLLabelElement>
>;
declare const FieldDescription: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLParagraphElement> &
    React.RefAttributes<HTMLParagraphElement>
>;
declare const FieldMessage: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLParagraphElement> & {
    tone?: "default" | "danger" | "success";
  } & React.RefAttributes<HTMLParagraphElement>
>;

export { Field, FieldDescription, FieldLabel, FieldMessage };
//# sourceMappingURL=field.d.ts.map
