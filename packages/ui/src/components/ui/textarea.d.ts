import { type VariantProps } from "class-variance-authority";
import * as React from "react";

declare const textareaVariants: (
  props?:
    | ({
        variant?: "default" | "config" | "form" | null | undefined;
        density?: "default" | "compact" | "relaxed" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  hasError?: boolean;
}
declare const Textarea: React.ForwardRefExoticComponent<
  TextareaProps & React.RefAttributes<HTMLTextAreaElement>
>;

export { Textarea, textareaVariants };
//# sourceMappingURL=textarea.d.ts.map
