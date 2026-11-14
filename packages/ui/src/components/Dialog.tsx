import type { ComponentProps } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn, focusRing } from "../lib/cn.ts";

export type DialogProps = ComponentProps<typeof DialogPrimitive.Root>;
export type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** The accessible name of the close button. */
  closeLabel?: string;
};
export type DialogTitleProps = ComponentProps<typeof DialogPrimitive.Title>;

/** A modal task: holds a `DialogTrigger` and a `DialogContent`. */
export function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root {...props} />;
}

/** Opens the dialog; pass `asChild` to use a `Button`. */
export const DialogTrigger = DialogPrimitive.Trigger;

/** Closes the dialog; pass `asChild` to use a `Button`. */
export const DialogClose = DialogPrimitive.Close;

/** The panel over a dimmed page. Needs a `DialogTitle`; Escape and the close button dismiss it. */
export function DialogContent({ closeLabel = "Close", className, children, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 bg-foreground/50" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn("fixed top-1/2 left-1/2 flex w-full max-w-md -translate-1/2 flex-col gap-4 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg outline-none", className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close aria-label={closeLabel} className={cn(focusRing, "absolute top-4 right-4 rounded-sm text-muted-foreground hover:text-foreground")}>
          <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
            <path d="m3 3 10 10M13 3 3 13" />
          </svg>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** The dialog's heading and accessible name. */
export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return <DialogPrimitive.Title className={cn("text-base leading-none font-semibold", className)} {...props} />;
}
