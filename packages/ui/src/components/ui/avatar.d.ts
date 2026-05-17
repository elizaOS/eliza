import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type * as React from "react";

declare function Avatar({
  className,
  ...props
}: React.ComponentProps<
  typeof AvatarPrimitive.Root
>): import("react/jsx-runtime").JSX.Element;
declare function AvatarImage({
  className,
  ...props
}: React.ComponentProps<
  typeof AvatarPrimitive.Image
>): import("react/jsx-runtime").JSX.Element;
declare function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<
  typeof AvatarPrimitive.Fallback
>): import("react/jsx-runtime").JSX.Element;

export { Avatar, AvatarFallback, AvatarImage };
//# sourceMappingURL=avatar.d.ts.map
