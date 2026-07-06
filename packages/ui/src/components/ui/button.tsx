/**
 * The kit's base button and its cva `buttonVariants` (default/destructive/
 * outline/secondary/ghost/link × size). The canonical primitive in
 * components/ui — other components (alert-dialog, banner, …) reuse
 * `buttonVariants` rather than restyling their own buttons. `asChild` renders
 * the styling onto a Radix Slot child so links can adopt button appearance.
 * Accent-orange resting → darker-orange hover per the brand hover system.
 *
 * On coarse-pointer (touch) surfaces the compact sizes compose a 44px hit floor
 * (`pointer-coarse:min-h/min-w-touch` = `--min-touch-target`) so the rendered
 * tap target meets the Apple-HIG minimum the tap-target-geometry gate enforces,
 * without enlarging the fine-pointer (mouse) resting look — the glyph keeps its
 * declared size; only the clickable box grows. `min-*` composes with a caller's
 * `h-*`/`w-*` override, so a shrunk icon button (e.g. the chat header's
 * `h-9 w-9`) still reaches the floor on touch.
 */
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium  transition-colors     disabled:pointer-events-none disabled:opacity-50 cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent-hover",
        surface: "bg-card text-muted-strong hover:bg-surface",
        surfaceAccent:
          "bg-accent-subtle text-txt-strong hover:bg-accent-subtle/70",
        surfaceDestructive:
          "bg-destructive-subtle text-danger hover:bg-destructive-subtle/70",
        destructive:
          "bg-destructive text-destructive-fg hover:bg-destructive/85",
        outline: "bg-card text-txt hover:bg-surface",
        secondary: "bg-bg-accent text-txt hover:bg-surface",
        ghost: "text-muted-strong hover:bg-surface hover:text-txt",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 px-4 py-2 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        sm: "h-9 rounded-sm px-3 py-1.5 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        lg: "h-11 rounded-sm px-8 py-2.5",
        icon: "h-10 w-10 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        "icon-sm":
          "h-8 w-8 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        "icon-lg": "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  unstyled?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      style,
      type,
      unstyled = false,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    // Default to type="button" so a Button inside or near a <form> doesn't
    // accidentally submit on Enter. Callers that genuinely want submit behaviour
    // must opt in with type="submit". Native <button> defaults to "submit",
    // which is almost never what we want in this app.
    const resolvedType = asChild ? type : (type ?? "button");
    return (
      <Comp
        className={
          unstyled
            ? cn(className)
            : cn(buttonVariants({ variant, size, className }))
        }
        ref={ref}
        style={style}
        type={resolvedType}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
