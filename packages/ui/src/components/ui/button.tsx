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
  // Disabled states keep solid type color (no blanket opacity) so labels stay
  // readable on accent fills — opacity-50 made orange CTAs look muddy/gray.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors disabled:pointer-events-none disabled:cursor-not-allowed cursor-pointer [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Keep disabled primary actions visibly subdued without lowering the
        // orange fill so far that its dark label loses contrast (45% failed).
        default:
          "bg-accent text-accent-fg hover:bg-accent-hover disabled:bg-accent/80 disabled:text-accent-fg",
        surface:
          "bg-card text-txt-strong hover:bg-surface disabled:text-muted-strong",
        surfaceAccent:
          "bg-accent-subtle text-txt-strong hover:bg-accent-subtle/70 disabled:text-muted-strong",
        surfaceDestructive:
          "bg-destructive-subtle text-danger hover:bg-destructive-subtle/70 disabled:text-muted-strong",
        destructive:
          "bg-destructive text-destructive-fg hover:bg-destructive/85 disabled:bg-destructive/65 disabled:text-destructive-fg",
        outline:
          "border border-border bg-card text-txt-strong hover:border-border-strong hover:bg-surface hover:text-txt-strong disabled:border-border/60 disabled:bg-card disabled:text-muted-strong",
        secondary:
          "bg-bg-accent text-txt-strong hover:bg-surface disabled:text-muted-strong",
        ghost:
          "text-txt-strong hover:bg-surface hover:text-txt-strong disabled:text-muted-strong",
        link: "text-accent underline-offset-4 hover:underline disabled:text-muted-strong",
        selection:
          "bg-transparent text-txt-strong hover:bg-accent-subtle data-[state=on]:bg-accent-subtle data-[state=on]:text-txt-strong",
        choice:
          "border border-border bg-bg text-txt-strong hover:border-accent hover:bg-accent-subtle data-[state=on]:border-accent data-[state=on]:bg-accent-subtle",
        publicRow:
          "h-full min-w-0 flex-1 justify-start gap-4 rounded-none bg-transparent p-0 text-left text-black whitespace-normal hover:bg-transparent hover:text-white",
        publicTile:
          "h-[72px] w-full justify-start gap-4 rounded-xs bg-white px-5 text-left text-black whitespace-normal hover:bg-black hover:text-white",
        publicPrimary:
          "h-[72px] w-full justify-start gap-4 rounded-xs bg-accent px-5 text-left text-accent-fg whitespace-normal hover:bg-accent-hover",
        publicLink:
          "h-auto bg-transparent p-0 text-xs text-muted underline-offset-2 hover:bg-transparent hover:text-txt",
        weatherPrompt:
          "flex-col items-end bg-transparent text-right text-white transition-opacity hover:bg-transparent hover:opacity-80",
        launcherTile:
          "flex-col gap-2.5 rounded-2xl bg-transparent text-white hover:bg-transparent hover:text-white",
        queryHistory:
          "h-auto w-full justify-start whitespace-normal rounded-sm bg-transparent px-3 py-2 text-left font-mono text-xs-tight text-muted-strong hover:bg-surface hover:text-txt",
        dangerOutline:
          "border border-danger/30 bg-transparent text-danger hover:border-danger/50 hover:bg-danger/10 hover:text-danger",
        ghostMuted: "bg-transparent text-muted hover:bg-surface hover:text-txt",
        externalLink:
          "h-auto bg-transparent p-0 text-left text-xs font-normal text-accent underline-offset-2 hover:bg-transparent hover:underline",
        sectionToggle:
          "h-auto w-full justify-start gap-2 rounded-sm bg-transparent px-3 py-2 text-left hover:bg-bg-hover",
        dangerGhost:
          "bg-transparent text-muted hover:bg-danger/10 hover:text-danger",
        outlineMuted:
          "border border-border bg-card text-muted-strong hover:border-border-strong hover:bg-surface hover:text-txt",
        mutedLink:
          "h-auto bg-transparent p-0 text-xs font-medium text-muted underline-offset-2 hover:bg-transparent hover:text-accent hover:underline",
        warningOutline:
          "border border-warning/35 bg-warning/12 text-warning hover:border-warning/50 hover:bg-warning/18 hover:text-warning",
        outlineAccent:
          "border border-border/40 bg-card/40 text-muted transition-all hover:border-accent hover:bg-accent/5 hover:text-txt",
        mobileBack:
          "h-auto justify-start gap-2 bg-transparent px-0 py-2 text-base font-medium text-muted hover:bg-transparent hover:text-txt",
        mediaZoom: "h-auto rounded-sm bg-transparent p-0 hover:bg-transparent",
        transparent: "bg-transparent hover:bg-transparent",
      },
      size: {
        default:
          "h-10 px-4 py-2 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        sm: "h-9 rounded-sm px-3 py-1.5 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        lg: "h-11 rounded-sm px-8 py-2.5",
        icon: "h-10 w-10 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        "icon-sm":
          "size-8 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        "icon-lg": "size-11",
        touch: "min-h-11 px-4 py-2",
        row: "min-h-16 w-full px-3 py-2",
        tile: "min-h-12 flex-col gap-1 px-2 py-2 text-xs",
        card: "min-h-20 flex-col items-stretch p-3",
        content: "h-auto w-auto min-w-0 p-0",
        compact: "h-9 rounded-sm px-3 text-xs",
        dense: "h-8 rounded-sm px-3 text-xs",
        short: "h-8 rounded-sm px-3 text-sm",
        regularCompact: "h-9 rounded-sm px-3 text-sm",
        tiny: "h-7 rounded-sm px-2.5 text-xs",
        wide: "h-10 rounded-sm px-6 text-sm",
        micro: "h-6 rounded-sm px-2 py-0 text-xs",
        tinyWide: "h-7 rounded-sm px-3 text-xs-tight",
        pill: "h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em]",
        badge:
          "h-auto rounded-full px-3 py-1.5 text-2xs font-bold tracking-[0.14em]",
        denseWide: "h-8 rounded-sm px-4 text-xs-tight font-semibold",
        compactWide: "h-9 rounded-sm px-4 text-xs-tight font-semibold",
        eventRow: "h-auto min-h-11 w-full items-start gap-1 p-0",
        formAction: "h-10 rounded-sm px-4 text-xs-tight font-semibold",
        disclosure:
          "size-5 shrink-0 rounded-sm p-0 text-left text-xs text-muted",
        pillDense: "h-8 rounded-full px-3 text-xs-tight font-semibold",
        zoomPill:
          "h-7 min-w-10 rounded-full px-1 text-2xs font-semibold tabular-nums",
        fill: "h-full w-full rounded-sm p-0",
      },
      shape: {
        default: "",
        circle: "rounded-full",
      },
      align: {
        center: "text-center",
        start: "justify-start text-left whitespace-normal",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      shape: "default",
      align: "center",
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
      shape,
      align,
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
            : cn(buttonVariants({ variant, size, shape, align, className }))
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
