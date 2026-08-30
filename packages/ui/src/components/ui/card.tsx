/**
 * Surface container primitive plus its slot parts (Header, Title, Description,
 * Action, Content, Footer). Orthogonal axes own reusable layout and surface
 * concerns; the maintained variants cover shared container recipes.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const cardVariants = cva("rounded-sm bg-card/70 text-card-fg", {
  variants: {
    variant: {
      default: "",
      flatPadded: "bg-card p-4",
      outlinedPadded: "border border-border bg-card p-4",
      reportPanel: "border border-border/70 bg-background/85",
      insetCompact: "border border-border bg-surface px-3 py-2",
      insetPadded: "border border-border bg-surface p-3",
      transparent: "bg-transparent",
      transparentSquare: "rounded-none bg-transparent",
      dashed:
        "border border-dashed border-border bg-bg/40 transition-colors hover:border-accent/40",
      dashedEmpty:
        "border border-dashed border-border bg-bg/40 px-4 py-6 text-sm text-muted transition-colors hover:border-accent/40",
      accentTile:
        "flex items-center justify-center border border-accent/20 bg-accent/10 text-accent",
      brand: "relative border border-border bg-bg-elevated p-4 text-txt md:p-6",
      panel: "border border-border/60 bg-card/92",
      sidebarIcon: "bg-bg-accent/80 text-muted",
      sidebarIconActive: "bg-accent/18 text-txt-strong",
      topDivider: "rounded-none border-t border-border/30 bg-transparent",
      bottomDivider: "rounded-none border-b border-border/35 bg-transparent",
      appFallback: "bg-background text-muted-foreground",
      launcherIcon:
        "relative overflow-hidden rounded-2xl border border-border-launcher-icon bg-bg-launcher-icon text-txt-launcher-icon backdrop-blur-[18px] group-hover:bg-bg-launcher-icon-hover group-focus-visible:border-accent group-focus-visible:bg-bg-launcher-icon-focus !shadow-launcher-icon before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:bg-launcher-icon-sheen before:content-['']",
      accountConnect: "border border-border/60 bg-card p-3 text-sm",
      attachmentFrame:
        "overflow-hidden rounded-lg border border-border bg-card",
      attachmentHeader: "rounded-none border-b border-border bg-transparent",
      codePane: "rounded-none bg-card px-3 py-2",
      nativeTranscriptUser: "rounded-sm bg-accent/12 px-2.5 py-1.5",
      sidebarItemActive: "bg-accent-subtle text-txt-strong",
      sidebarRail:
        "border border-border/24 bg-card text-muted-strong hover:border-border/38 hover:bg-surface hover:text-txt data-[state=on]:border-accent data-[state=on]:bg-accent-subtle data-[state=on]:text-txt",
      sandboxFrame: "rounded-none border-0 bg-bg",
      configRow:
        "rounded-none border-b border-border/40 bg-transparent last:border-b-0",
      accountCard: "border border-border/45 bg-card/35",
      connectorInset:
        "border border-border/50 bg-bg-accent/40 px-3 py-2 text-xs text-muted",
      connectorAvatar:
        "overflow-hidden border border-border/50 bg-bg-accent text-xs font-semibold text-muted",
      connectorPanel: "border border-border/40 bg-bg/60",
      vaultForm: "border border-border/50 bg-card/30 p-2",
      vaultEmpty:
        "border border-dashed border-border/50 bg-card/20 p-3 text-center text-xs text-muted",
      vaultListRow: "bg-transparent px-2 py-1.5 hover:bg-bg-muted/30",
      vaultError:
        "border border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger",
      vaultInset: "border border-border/50 bg-bg/30 p-3",
      vaultSuccessStrip:
        "rounded-none border-l-2 border-ok/50 bg-ok/10 px-2 py-1.5 text-xs text-ok",
      vaultDangerStrip:
        "rounded-none border-l-2 border-danger/60 bg-danger/10 px-2 py-1.5 text-xs text-danger",
      vaultConfirm: "border border-danger/40 bg-danger/5 p-2",
      pairingGate:
        "relative z-10 w-full max-w-[620px] overflow-hidden border border-border/60 bg-card/95",
      cloudPaymentPublic:
        "rounded-xs border border-inverse-foreground/12 bg-inverse/88 text-inverse-foreground",
      brandSurface: "border border-brand-surface bg-surface",
      billingTopDivider:
        "rounded-none border-0 border-t border-border bg-transparent",
      warningNotice: "border border-warning/40 bg-warning/10",
      dangerNotice: "border border-danger/30 bg-danger/10 p-4",
      codeFrame: "rounded-sm border border-border bg-card",
      codeHeader: "rounded-none border-0 border-b border-border bg-bg-muted",
      appWindowState: "rounded-none border-0 bg-bg text-txt",
    },
    stack: {
      none: "",
      compact: "space-y-3",
      default: "space-y-4",
    },
    flow: {
      none: "",
      column: "flex flex-col",
      row: "flex items-center",
      rowBetween: "flex items-center justify-between",
    },
    gap: {
      none: "",
      tight: "gap-1.5",
      compact: "gap-2",
      default: "gap-3",
    },
    padding: {
      none: "",
      compact: "px-3 py-2",
      default: "p-3",
      comfortable: "p-4",
    },
    tone: {
      default: "",
      muted: "text-muted",
      strong: "text-txt-strong",
      mutedStrong: "text-muted-strong",
      text: "text-txt",
      inverse: "text-inverse-foreground",
    },
    surface: {
      default: "",
      transparent: "bg-transparent",
      card: "bg-card",
      raised: "bg-surface",
      destructiveSubtle: "bg-destructive/5",
      cardOverlay: "bg-card/95",
      backgroundSubtle: "bg-bg/50",
      backgroundStrong: "bg-bg/80",
      accentSubtle: "bg-accent/5",
      inverseForeground: "bg-inverse-foreground",
      wallpaperOverlay: "bg-bg-wallpaper-overlay",
    },
    border: {
      default: "",
      none: "border-0",
      standard: "border border-border",
      subtle: "border border-border/60",
      strong: "border border-border-strong",
      destructive: "border border-destructive/30",
      accent: "border border-accent/20",
    },
    radius: {
      default: "",
      none: "rounded-none",
      large: "rounded-lg",
      full: "rounded-full",
      xlarge: "rounded-2xl",
    },
    shadow: {
      default: "",
      none: "shadow-none",
    },
  },
  defaultVariants: {
    variant: "default",
    stack: "none",
    flow: "none",
    gap: "none",
    padding: "none",
    tone: "default",
    surface: "default",
    border: "default",
    radius: "default",
    shadow: "default",
  },
});

const CARD_TOKEN_STYLE_KEYS = [
  "--accent-subtle",
  "--bg",
  "--card",
  "--card-foreground",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--muted-strong",
  "--plugin-border",
  "--plugin-error",
  "--plugin-error-size",
  "--plugin-field-gap",
  "--plugin-focus-ring",
  "--plugin-group-gap",
  "--plugin-help",
  "--plugin-help-size",
  "--plugin-input-height",
  "--plugin-label",
  "--plugin-label-size",
  "--plugin-max-field-width",
  "--plugin-section-padding",
  "--text",
  "--text-strong",
  "--txt",
] as const;

type CardTokenStyleKey = (typeof CARD_TOKEN_STYLE_KEYS)[number];

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  asChild?: boolean;
  elevation?: "liquidGlass";
  /** Canonical glass material supplied by the shared glass recipe. */
  glass?: "sheet";
  /** High-contrast grabber paint shared by shell overlay handles. */
  overlayHandle?: boolean;
  /** Styled scrollbar paint applied by the surface atom. */
  scrollbar?: "styled";
  /** Bottom-up contrast scrim for copy rendered over wallpaper imagery. */
  wallpaperScrim?: boolean;
  /** Semantic or runtime CSS variables consumed by this surface subtree. */
  tokenStyle?: Partial<Record<CardTokenStyleKey, string | number>>;
  /** Runtime paint data applied by the surface atom. */
  visualStyle?: Pick<
    React.CSSProperties,
    | "backdropFilter"
    | "background"
    | "backgroundColor"
    | "backgroundImage"
    | "border"
    | "borderBottom"
    | "borderColor"
    | "borderLeft"
    | "borderRadius"
    | "borderRight"
    | "borderTop"
    | "boxShadow"
    | "color"
    | "WebkitBackdropFilter"
  >;
  /** Runtime geometry kept separate from atom-owned visual paint. */
  layoutStyle?: Pick<
    React.CSSProperties,
    | "bottom"
    | "boxSizing"
    | "clipPath"
    | "display"
    | "height"
    | "inset"
    | "left"
    | "marginBottom"
    | "maxHeight"
    | "maxWidth"
    | "minHeight"
    | "minWidth"
    | "opacity"
    | "overflow"
    | "pointerEvents"
    | "position"
    | "right"
    | "top"
    | "transform"
    | "transformOrigin"
    | "WebkitClipPath"
    | "width"
    | "zIndex"
  >;
  wallpaperText?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      asChild = false,
      border,
      className,
      elevation,
      flow,
      gap,
      glass,
      layoutStyle,
      overlayHandle = false,
      padding,
      radius,
      scrollbar,
      shadow,
      stack,
      style,
      surface,
      tokenStyle,
      variant,
      visualStyle,
      tone,
      wallpaperScrim = false,
      wallpaperText = false,
      ...props
    },
    ref,
  ) => {
    const Component = asChild ? Slot : "div";
    return (
      <Component
        ref={ref}
        className={cn(
          cardVariants({
            border,
            flow,
            gap,
            padding,
            radius,
            shadow,
            stack,
            surface,
            tone,
            variant,
          }),
          glass === "sheet" ? "eliza-glass-sheet" : undefined,
          overlayHandle ? "chat-handle-bar-surface" : undefined,
          scrollbar === "styled" ? "custom-scrollbar" : undefined,
          wallpaperScrim
            ? "bg-linear-to-t from-scrim/80 to-transparent"
            : undefined,
          className,
        )}
        style={{
          ...(elevation === "liquidGlass"
            ? {
                boxShadow:
                  "inset 0 1px 0 0 rgb(255 255 255 / 0.5000), inset 0 -1px 0 0 rgb(255 255 255 / 0.1400), inset 0 -20px 40px -26px rgb(0 0 0 / 0.4200)",
              }
            : null),
          ...(wallpaperText ? { color: "white" } : null),
          ...style,
          ...tokenStyle,
          ...layoutStyle,
          ...visualStyle,
        }}
        {...props}
      />
    );
  },
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn("font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn("text-sm text-muted", className)} {...props} />
));
CardDescription.displayName = "CardDescription";

const CardAction = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="card-action"
    className={cn(
      "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
      className,
    )}
    {...props}
  />
));
CardAction.displayName = "CardAction";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
};
