/**
 * Modal dialog primitive family (root, trigger, overlay, content with close
 * button, header/footer, title/description) wrapping the Radix dialog
 * primitives with the kit's tokens. The base dialog in components/ui; the
 * denser admin variant composes on top of it (admin-dialog.tsx).
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../../lib/utils";

// Overlay/content z-index must be a literal arbitrary class (`z-[160]` /
// `z-[170]`) so Tailwind v4's source scanner emits it — Tailwind cannot resolve
// classes built from runtime template-literal values, and a non-emitted class
// drops `position: fixed`/stacking so page chrome shows through the modal. Keep
// in sync with packages/ui/src/lib/floating-layers.ts
// (Z_DIALOG_OVERLAY = 160, Z_DIALOG = 170).

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[160] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Portal to a specific DOM element (e.g. document.body) to escape 3D-transform stacking contexts */
    container?: HTMLElement | null;
    /** Hide the default top-right close button when the consumer renders its own close affordance. */
    showCloseButton?: boolean;
  }
>(
  (
    { className, children, container, showCloseButton = true, ...props },
    ref,
  ) => (
    <DialogPortal container={container}>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-[50%] top-[50%] z-[170] grid w-[min(calc(100vw_-_1.5rem),42rem)] max-h-[min(calc(100dvh_-_1.5rem_-_var(--safe-area-top,0px)_-_var(--safe-area-bottom,0px)),44rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-sm border border-border bg-bg p-5 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:p-6",
          "fixed left-[50%] top-[50%] z-[170] grid w-[min(calc(100vw_-_1.5rem),42rem)] max-h-[min(calc(100dvh_-_1.5rem_-_var(--safe-area-top,0px)_-_var(--safe-area-bottom,0px)),44rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-hidden rounded-sm border border-border bg-bg p-5 text-txt duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:p-6",
          "max-sm:left-1/2 max-sm:top-auto max-sm:bottom-[max(0.75rem,var(--safe-area-bottom,0px))] max-sm:max-h-[min(calc(100dvh_-_1rem_-_var(--safe-area-top,0px)_-_var(--safe-area-bottom,0px)),42rem)] max-sm:w-[min(calc(100vw_-_1rem),42rem)] max-sm:translate-y-0 max-sm:rounded-sm max-sm:data-[state=closed]:slide-out-to-bottom-6 max-sm:data-[state=open]:slide-in-from-bottom-6",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted opacity-70 transition-opacity hover:text-txt hover:opacity-100 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end sm:pt-5",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
