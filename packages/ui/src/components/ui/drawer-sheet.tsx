import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { Z_DIALOG, Z_DIALOG_OVERLAY } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";

const DrawerSheet = DialogPrimitive.Root;

const DrawerSheetTrigger = DialogPrimitive.Trigger;

const DrawerSheetPortal = DialogPrimitive.Portal;

const DrawerSheetClose = DialogPrimitive.Close;

const DrawerSheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      `fixed inset-0 z-[${Z_DIALOG_OVERLAY}] bg-black/72 backdrop-blur-[2px] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0`,
      className,
    )}
    {...props}
  />
));
DrawerSheetOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DrawerSheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    container?: HTMLElement | null;
    showCloseButton?: boolean;
  }
>(
  (
    { className, children, container, showCloseButton = false, ...props },
    ref,
  ) => (
    <DrawerSheetPortal container={container}>
      <DrawerSheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          `fixed left-[max(0.5rem,var(--safe-area-left,0px))] right-[max(0.5rem,var(--safe-area-right,0px))] bottom-[max(0.5rem,var(--safe-area-bottom,0px))] z-[${Z_DIALOG}] flex max-h-[min(calc(100dvh_-_1rem_-_var(--safe-area-top,0px)_-_var(--safe-area-bottom,0px)),44rem)] flex-col overflow-hidden rounded-[1.25rem] border border-border/70 bg-bg shadow-[0_24px_70px_rgba(2,8,23,0.28)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom-6 data-[state=open]:slide-in-from-bottom-6`,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-bg transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DrawerSheetPortal>
  ),
);
DrawerSheetContent.displayName = DialogPrimitive.Content.displayName;

const DrawerSheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col gap-1.5 text-left", className)}
    {...props}
  />
);
DrawerSheetHeader.displayName = "DrawerSheetHeader";

const DrawerSheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-base font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DrawerSheetTitle.displayName = DialogPrimitive.Title.displayName;

const DrawerSheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted", className)}
    {...props}
  />
));
DrawerSheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  DrawerSheet,
  DrawerSheetClose,
  DrawerSheetContent,
  DrawerSheetDescription,
  DrawerSheetHeader,
  DrawerSheetOverlay,
  DrawerSheetPortal,
  DrawerSheetTitle,
  DrawerSheetTrigger,
};
