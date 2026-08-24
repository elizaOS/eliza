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
          "h-auto w-full flex-col gap-2.5 rounded-2xl bg-transparent p-0 text-white whitespace-normal hover:bg-transparent hover:text-white",
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
        disclosureMuted:
          "w-full justify-between bg-transparent text-xs text-muted hover:bg-transparent hover:text-txt",
        ghostFaded:
          "bg-transparent text-muted opacity-70 hover:bg-surface hover:text-txt hover:opacity-100",
        accentGhost:
          "bg-transparent text-accent hover:bg-transparent hover:text-accent-muted",
        setupLink:
          "h-auto bg-transparent p-0 text-sm text-[var(--first-run-text-muted)] underline underline-offset-2 hover:bg-transparent hover:opacity-80",
        overlayEdge:
          "bg-transparent text-white/55 hover:bg-transparent hover:text-white",
        micToggle:
          "bg-transparent text-muted-strong hover:bg-transparent hover:text-txt data-[state=on]:text-accent",
        wallpaperRow:
          "bg-transparent hover:bg-white/8 data-[active=true]:bg-white/15",
        wallpaperControl:
          "bg-transparent text-muted-strong hover:bg-transparent hover:text-txt data-[state=on]:text-white data-[state=on]:hover:text-white aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40",
        homePill:
          "rounded-full bg-transparent shadow-none hover:bg-transparent active:scale-95 data-[needs-auth=true]:active:scale-[0.96] focus-visible:bg-transparent focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        notificationClear:
          "text-white/60 hover:text-white/90 data-[confirming=true]:text-white",
        topicPill:
          "border border-white/15 bg-white/10 text-white/80 hover:bg-white/20 hover:text-white",
        topicHeader:
          "bg-transparent text-white/45 hover:bg-transparent hover:text-white/70",
        sidebarRail:
          "border border-border/24 bg-card text-xs font-semibold tracking-[0.02em] text-muted-strong transition-[border-color,background-color,color,box-shadow,transform] duration-150 hover:border-border/38 hover:bg-surface hover:text-txt active:scale-[0.98] data-[state=on]:border-accent data-[state=on]:bg-accent-subtle data-[state=on]:text-txt",
        sidebarAction:
          "bg-bg/80 text-muted opacity-0 group-hover:opacity-100 hover:bg-danger/10 hover:text-danger",
        confirmDanger:
          "border border-destructive/70 bg-destructive text-destructive-fg hover:border-destructive hover:bg-destructive",
        confirmWarning:
          "border border-warn/55 bg-warn/92 text-black hover:border-warn hover:bg-warn",
        calendarDay:
          "font-normal data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground group-data-[focused=true]/day:border-ring dark:hover:text-accent-foreground data-[range-end=true]:rounded-sm data-[range-end=true]:rounded-r-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-sm data-[range-start=true]:rounded-l-md",
        pageDrawerTrigger:
          "border border-border bg-card text-txt hover:border-border-strong hover:bg-surface hover:text-txt",
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
        closeGlyph: "size-8 rounded-sm p-0 text-xl leading-none",
        inlineIcon: "h-auto px-2 py-0 text-xs",
        labeledSm:
          "h-9 gap-2 rounded-sm px-3 py-1.5 pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        labeledForm:
          "h-10 gap-1.5 rounded-sm px-4 text-xs font-semibold pointer-coarse:min-h-touch pointer-coarse:min-w-touch",
        rowContent: "h-auto gap-3 rounded-none p-0 font-normal",
        sidebarToggle:
          "h-auto gap-1.5 rounded-sm px-1.5 py-1 text-xs font-medium leading-none",
        labeledTiny: "h-7 gap-1 rounded-sm px-2.5 text-xs",
        "icon-xs": "size-6 rounded-sm p-0",
        "icon-2xs": "size-4 rounded-sm p-0",
        labeledMicro:
          "h-auto gap-0.5 rounded-sm px-1 py-0 text-2xs font-semibold",
        trayRow: "h-9 gap-3 rounded-sm px-2 text-sm font-normal",
        wallpaperRow:
          "h-auto w-full gap-3 rounded-none px-3.5 py-2 font-normal",
        pillHandle: "h-auto w-full rounded-none px-8 pb-1.5 pt-10",
        warningPill:
          "h-auto gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium",
        homePill:
          "h-11 w-16 p-0 data-[composer-sized=true]:h-16 data-[composer-sized=true]:w-[36rem]",
        notificationClear: "h-8 overflow-hidden text-xs font-medium",
        topicPill: "h-auto w-full gap-2 rounded-full px-3 py-1.5 font-normal",
        topicHeader: "h-auto w-full gap-2 py-1 font-normal",
        sidebarItem: "h-auto gap-3 rounded-none p-0 font-normal",
        toolbar: "h-10 rounded-sm px-3 text-sm",
        newAction:
          "min-h-touch w-full justify-start rounded-sm px-4 py-2.5 text-sm font-medium",
        carouselControl: "size-8 rounded-sm p-0",
        calendarDay:
          "aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none [&>span]:text-xs [&>span]:opacity-70",
        pageDrawerTrigger: "h-[2.375rem] rounded-sm px-3 text-sm font-semibold",
        memorySidebar:
          "h-11 w-full justify-between gap-2 rounded-sm px-3 text-start text-sm font-medium",
      },
      shape: {
        default: "",
        circle: "rounded-full",
        "2xl": "rounded-2xl",
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
