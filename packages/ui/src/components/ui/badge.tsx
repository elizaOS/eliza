/**
 * Inline status/label pill with cva-driven variants (default, secondary,
 * destructive, outline). A leaf primitive in the components/ui base layer.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-sm border px-2.5 py-0.5 text-xs font-semibold transition-colors    ",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-fg hover:bg-primary/80",
        secondary: "border-transparent bg-bg-accent text-txt hover:bg-bg-hover",
        destructive:
          "border-transparent bg-destructive text-destructive-fg hover:bg-destructive/80",
        outline: "text-txt border-border",
        ownerOverlay:
          "absolute -right-0.5 -top-0.5 border-0 bg-bg/90 p-0.5 text-accent shadow",
        ownerCard: "border-0 bg-accent/15 px-2 py-1 text-accent",
        ownerInline: "rounded-none border-0 bg-transparent p-0 text-accent",
        metaAccent:
          "border-accent/55 bg-accent-subtle font-bold text-txt-strong",
        metaStrong: "border-border bg-card font-medium text-txt-strong",
        metaDefault: "border-border bg-card font-medium text-muted",
        statusSuccess: "border-ok/35 bg-ok/12 text-ok",
        statusWarning: "border-warn/40 bg-warn/14 text-warn",
        statusDanger:
          "border-destructive/35 bg-destructive/12 text-destructive",
        statusInfo: "border-status-info/35 bg-status-info-bg text-status-info",
        statusMuted: "border-border bg-bg-accent text-muted-strong",
        capabilityMissing: "rounded border-dashed border-border/60 text-muted",
        capabilityGranted:
          "rounded border-transparent bg-accent-subtle text-accent-muted",
        primingIcon: "border-border bg-bg-accent text-accent",
        requiredStatus:
          "border-transparent bg-destructive-subtle text-destructive",
        providerMarkActive: "border-border-strong bg-card p-0 text-txt-strong",
        providerMark: "border-border/50 bg-bg-accent/60 p-0 text-muted-strong",
        chartIndicatorDot:
          "size-2.5 shrink-0 rounded-sm border-border bg-card p-0",
        chartIndicatorLine: "w-1 shrink-0 rounded-sm border-border bg-card p-0",
        chartIndicatorDashed:
          "w-0 shrink-0 rounded-sm border-2 border-dashed border-border bg-transparent p-0",
        keyHint:
          "border-border/50 bg-card px-1.5 py-0.5 text-2xs font-medium text-muted",
        adminMono:
          "rounded-sm border-border bg-bg-hover px-1.5 py-0.5 font-mono text-2xs font-normal text-muted",
        vaultAccent:
          "rounded-full border-accent/40 bg-accent/10 px-1.5 py-0.5 text-2xs font-medium text-accent",
        vaultInfo:
          "rounded-full border-status-info/40 bg-status-info/10 px-1.5 py-0.5 text-2xs font-medium text-status-info",
        vaultStatusSuccess:
          "rounded-full border-ok/30 bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok",
        vaultStatusWarning:
          "rounded-full border-warn/30 bg-warn/10 px-1.5 py-0.5 text-2xs font-medium text-warn",
        vaultStatusWarningDot:
          "size-1.5 rounded-full border-0 bg-warning p-0 text-warning",
        vaultStatusMuted:
          "rounded-full border-border/40 bg-bg/40 px-1.5 py-0.5 text-2xs font-medium text-muted",
        statusDotSuccess: "size-2 rounded-full border-0 bg-status-success p-0",
        statusDotWarning: "size-2 rounded-full border-0 bg-status-warning p-0",
        statusDotDanger: "size-2 rounded-full border-0 bg-danger p-0",
        statusDotMuted: "size-2 rounded-full border-0 bg-bg/40 p-0",
        mutedDot: "size-2 rounded-full border-0 bg-muted p-0",
        earningsPending:
          "border-status-warning/30 bg-status-warning-bg text-status-warning",
        earningsNeutral: "border-border bg-bg-muted text-muted-strong",
        earningsCompleted:
          "border-status-success/30 bg-status-success-bg text-status-success",
        earningsFailed:
          "border-destructive/30 bg-destructive-subtle text-destructive",
        chainDot:
          "inline-block size-2.5 rounded-full border-0 bg-transparent p-0",
        visualAnchor: "border-0 bg-transparent p-0",
        drawerHandle:
          "h-1.5 w-[100px] rounded-full border-0 bg-border p-0 transition-[width,background-color] group-hover:w-[112px] group-hover:bg-border-strong",
        permissionCode:
          "border-border px-1.5 py-0.5 font-mono text-2xs font-normal text-muted",
        meetingPlatform: "border-border bg-transparent py-0.5 text-txt",
        meetingPrivacy: "border-border bg-bg-hover py-0.5 text-muted-strong",
        meetingPrivacyDanger:
          "border-destructive/40 bg-danger/10 py-0.5 text-danger",
        trajectoryStage:
          "border-border bg-transparent px-1.5 text-muted tracking-[0.12em]",
      },
      size: {
        default: "",
        compact: "text-2xs uppercase",
        pill: "rounded-full px-2.5 py-1 text-xs-tight font-medium normal-case",
        micro: "border-0 px-1.5 py-0 text-3xs font-medium",
        microBold: "border-0 px-1.5 py-0 text-3xs font-bold",
        meta: "min-h-6 px-2.5 py-1 text-xs-tight",
        metaCompact: "min-h-0 px-2 py-1 text-2xs",
        providerMark:
          "flex size-8 shrink-0 items-center justify-center rounded-md",
      },
      tone: {
        default: "",
        accent: "bg-accent/12 text-accent-fg",
        success: "bg-ok/10 text-ok",
        warning: "bg-warn/10 text-warn",
        danger: "bg-danger/10 text-danger",
        muted: "bg-bg-hover text-muted-strong",
      },
      presentation: {
        default: "",
        launcherKind:
          "pointer-events-none absolute -left-1.5 -bottom-1 max-w-[3.75rem] truncate rounded-full border-0 bg-inverse-foreground/90 px-1.5 py-0.5 text-2xs font-semibold uppercase leading-none text-inverse",
        homePillIdle: "home-pill-mark-idle",
        homePillPreview: "home-pill-mark-preview",
        homePillListening: "home-pill-mark-listening",
        homePillChip: "home-pill-mark-chip",
        homePillResponding: "home-pill-mark-responding",
        homePillSpeaking: "home-pill-mark-speaking",
        homePillPreviewHandle: "home-pill-preview-handle",
        homePillWave: "home-pill-meter-surface",
        homePillProcessDot: "home-pill-process-dot-surface",
      },
      overlay: {
        default: "",
        agentIndicatorLabel:
          "pointer-events-none absolute -top-4 left-0 whitespace-nowrap rounded-sm border-0 bg-accent px-1 py-0 font-mono text-[10px] leading-[14px] text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      tone: "default",
      presentation: "default",
      overlay: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
  /** Runtime data color for chart indicators; paint stays owned by this atom. */
  indicatorColor?: string;
}

function Badge({
  asChild = false,
  className,
  variant,
  size,
  tone,
  presentation,
  overlay,
  indicatorColor,
  style,
  ...props
}: BadgeProps) {
  const Component = asChild ? Slot : "div";
  return (
    <Component
      className={cn(
        badgeVariants({ variant, size, tone, presentation, overlay }),
        className,
      )}
      style={
        indicatorColor
          ? {
              ...style,
              backgroundColor: indicatorColor,
              borderColor: indicatorColor,
            }
          : style
      }
      {...props}
    />
  );
}

export { Badge, badgeVariants };
