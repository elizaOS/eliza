import { type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Button } from "./button";

declare function InputGroup({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare const inputGroupAddonVariants: (
  props?:
    | ({
        align?:
          | "inline-start"
          | "inline-end"
          | "block-start"
          | "block-end"
          | null
          | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
declare function InputGroupAddon({
  className,
  align,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<
    typeof inputGroupAddonVariants
  >): import("react/jsx-runtime").JSX.Element;
declare const inputGroupButtonVariants: (
  props?:
    | ({
        size?: "sm" | "icon-sm" | "xs" | "icon-xs" | null | undefined;
      } & import("class-variance-authority/types").ClassProp)
    | undefined,
) => string;
declare function InputGroupButton({
  className,
  type,
  variant,
  size,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size"> &
  VariantProps<
    typeof inputGroupButtonVariants
  >): import("react/jsx-runtime").JSX.Element;
declare function InputGroupText({
  className,
  ...props
}: React.ComponentProps<"span">): import("react/jsx-runtime").JSX.Element;
declare function InputGroupInput({
  className,
  ...props
}: React.ComponentProps<"input">): import("react/jsx-runtime").JSX.Element;
declare function InputGroupTextarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): import("react/jsx-runtime").JSX.Element;

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
};
//# sourceMappingURL=input-group.d.ts.map
