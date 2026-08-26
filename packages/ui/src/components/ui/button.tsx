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
          "border border-border-strong bg-card text-txt-strong hover:border-accent hover:bg-surface disabled:opacity-40 aria-disabled:opacity-40 data-[state=on]:border-accent data-[state=on]:bg-accent data-[state=on]:text-accent-fg data-[state=on]:disabled:opacity-100 data-[state=on]:aria-disabled:opacity-100",
        publicRow:
          "h-full min-w-0 flex-1 justify-start gap-4 rounded-none bg-transparent p-0 text-left text-inverse-foreground whitespace-normal hover:bg-transparent hover:text-inverse",
        publicTile:
          "bg-inverse text-inverse-foreground hover:bg-inverse-foreground hover:text-inverse",
        publicLink:
          "h-auto bg-transparent p-0 text-xs text-muted underline-offset-2 hover:bg-transparent hover:text-txt",
        weatherPrompt:
          "flex-col items-end bg-transparent text-right text-inverse transition-opacity hover:bg-transparent hover:opacity-80",
        launcherTile:
          "h-auto w-full flex-col gap-2.5 rounded-2xl bg-transparent p-0 text-inverse whitespace-normal hover:bg-transparent hover:text-inverse",
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
          "border border-border/40 bg-card/40 text-muted transition-[border-color,background-color,color] hover:border-accent hover:bg-accent/5 hover:text-txt",
        mediaZoom: "h-auto rounded-sm bg-transparent p-0 hover:bg-transparent",
        transparent: "bg-transparent hover:bg-transparent",
        chatGestureTarget:
          "rounded-none border-0 bg-transparent hover:bg-transparent",
        disclosureMuted:
          "w-full justify-between bg-transparent text-xs text-muted hover:bg-transparent hover:text-txt",
        overlayEdge:
          "bg-transparent text-inverse/55 hover:bg-transparent hover:text-inverse",
        memorySidebar:
          "border border-border bg-card/40 text-txt hover:bg-card/70",
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
        regularCompact: "h-9 rounded-sm px-3 text-sm",
        tiny: "h-7 rounded-sm px-2.5 text-xs",
        wide: "h-10 rounded-sm px-6 text-sm",
        micro: "h-6 rounded-sm px-2 py-0 text-xs",
        tinyWide: "h-7 rounded-sm px-3 text-xs-tight",
        pill: "h-9 rounded-full px-4 text-xs-tight font-bold tracking-[0.12em]",
        badge:
          "h-auto rounded-full px-3 py-1.5 text-2xs font-bold tracking-[0.14em]",
        denseWide: "h-8 rounded-sm px-4 text-xs-tight font-semibold",
        eventRow: "h-auto min-h-11 w-full items-start gap-1 p-0",
        formAction: "h-10 rounded-sm px-4 text-xs-tight font-semibold",
        disclosure:
          "size-5 shrink-0 rounded-sm p-0 text-left text-xs text-muted",
        pillDense: "h-8 rounded-full px-3 text-xs-tight font-semibold",
        fill: "h-full w-full rounded-sm p-0",
        inlineIcon: "h-auto px-2 py-0 text-xs",
        rowContent: "h-auto gap-3 rounded-none p-0 font-normal",
        "icon-xs": "size-6 rounded-sm p-0",
        carouselControl: "size-8 rounded-sm p-0",
        pageDrawerTrigger: "h-9.5 rounded-sm px-3 text-sm font-semibold",
        publicTile:
          "h-18 w-full justify-start gap-4 rounded-xs px-5 text-left whitespace-normal",
        memorySidebar:
          "h-11 w-full justify-between gap-2 rounded-sm px-3 text-start text-sm font-medium",
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
  nativeTranscriptSummary?: boolean;
  /** Runtime paint data (for example provider palettes) applied by the atom. */
  visualStyle?: Pick<
    React.CSSProperties,
    | "background"
    | "backgroundColor"
    | "borderColor"
    | "borderRadius"
    | "boxShadow"
    | "color"
  >;
  /** Runtime geometry kept separate from atom-owned visual paint. */
  layoutStyle?: Pick<
    React.CSSProperties,
    | "boxSizing"
    | "cursor"
    | "display"
    | "flexDirection"
    | "fontFamily"
    | "gap"
    | "height"
    | "justifyContent"
    | "left"
    | "minHeight"
    | "minWidth"
    | "padding"
    | "textAlign"
    | "top"
    | "transition"
    | "width"
  >;
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
      visualStyle,
      layoutStyle,
      type,
      unstyled = false,
      nativeTranscriptSummary = false,
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
            : cn(
                buttonVariants({ variant, size, shape, align }),
                nativeTranscriptSummary &&
                  "min-h-11 w-full cursor-pointer list-none justify-start gap-2 px-1 text-xs outline-none [&::-webkit-details-marker]:hidden",
                className,
              )
        }
        ref={ref}
        style={
          visualStyle || layoutStyle
            ? { ...style, ...layoutStyle, ...visualStyle }
            : style
        }
        type={resolvedType}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
