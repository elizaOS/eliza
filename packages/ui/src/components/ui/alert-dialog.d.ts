import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type * as React from "react";

declare function AlertDialog({
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Root
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogTrigger({
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Trigger
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogPortal({
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Portal
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Overlay
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Content
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Title
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Description
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Action
>): import("react/jsx-runtime").JSX.Element;
declare function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<
  typeof AlertDialogPrimitive.Cancel
>): import("react/jsx-runtime").JSX.Element;

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
//# sourceMappingURL=alert-dialog.d.ts.map
