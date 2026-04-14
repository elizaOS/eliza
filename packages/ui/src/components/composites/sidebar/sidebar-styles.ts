import { cva } from "class-variance-authority";

export const sidebarRootVariants = cva(
  "mt-4 flex flex-col overflow-hidden text-sm transition-[width,min-width,border-radius,box-shadow,transform] duration-[360ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
  {
    variants: {
      variant: {
        default:
          "relative isolate min-h-0 h-[calc(100%-1rem)] w-full shrink-0 rounded-l-none rounded-tr-none rounded-br-none border-y-0 border-l-0 border-b border-border/34 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_76%,transparent),color-mix(in_srgb,var(--bg-muted)_97%,transparent))] ring-1 ring-border/12 backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.26),transparent)] after:pointer-events-none after:absolute after:bottom-0 after:right-0 after:top-[1.25rem] after:w-[2px] after:bg-[linear-gradient(180deg,rgba(255,255,255,0.06),transparent_24%,transparent)] lg:border-b-0 lg:border-r dark:ring-white/5 dark:before:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.12),transparent)] dark:after:bg-[linear-gradient(180deg,rgba(255,255,255,0.05),transparent_22%,transparent)]",
        mobile:
          "h-full w-full min-w-0 border-0 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_96%,transparent),color-mix(in_srgb,var(--bg)_92%,transparent))] shadow-none ring-0",
        "game-modal":
          "h-full rounded-sm border border-white/10 bg-[linear-gradient(180deg,rgba(11,12,17,0.9),rgba(8,10,14,0.82))] shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl",
      },
      collapsed: {
        true: "!w-[4.75rem] !min-w-[4.75rem] rounded-tr-none xl:!w-[4.75rem] xl:!min-w-[4.75rem]",
        false: "",
      },
    },
    compoundVariants: [
      {
        variant: "default",
        collapsed: false,
        className:
          "!w-[18.5rem] !min-w-[18.5rem] xl:!w-[20rem] xl:!min-w-[20rem]",
      },
      {
        variant: "default",
        collapsed: false,
        className:
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),inset_-1px_0_0_rgba(255,255,255,0.05),0_20px_40px_-26px_rgba(15,23,42,0.18),12px_0_24px_-20px_rgba(15,23,42,0.1)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_-1px_0_0_rgba(255,255,255,0.03),0_22px_42px_-28px_rgba(0,0,0,0.58),14px_0_24px_-18px_rgba(0,0,0,0.28),8px_-8px_16px_-24px_rgba(var(--accent-rgb),0.04)]",
      },
      {
        variant: "default",
        collapsed: true,
        className:
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_-1px_0_0_rgba(255,255,255,0.04),0_16px_30px_-24px_rgba(15,23,42,0.16),9px_0_18px_-16px_rgba(15,23,42,0.08)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),inset_-1px_0_0_rgba(255,255,255,0.025),0_18px_32px_-24px_rgba(0,0,0,0.5),10px_0_18px_-16px_rgba(0,0,0,0.24),6px_-6px_12px_-22px_rgba(var(--accent-rgb),0.035)]",
      },
    ],
    defaultVariants: {
      variant: "default",
      collapsed: false,
    },
  },
);

export const sidebarScrollRegionVariants = cva("", {
  variants: {
    variant: {
      default:
        "custom-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-3 supports-[scrollbar-gutter:stable]:[scrollbar-gutter:stable]",
      mobile:
        "custom-scrollbar min-h-0 w-full min-w-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3 pt-3 supports-[scrollbar-gutter:stable]:[scrollbar-gutter:stable]",
      "game-modal":
        "custom-scrollbar flex-1 min-h-0 w-full overflow-y-auto p-2.5",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export const sidebarPanelVariants = cva("", {
  variants: {
    variant: {
      default:
        "flex min-h-full flex-col gap-2 rounded-sm border border-border/12 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_16%,transparent),transparent_48%)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]",
      mobile:
        "flex min-h-full flex-col gap-2 rounded-sm border border-border/12 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_16%,transparent),transparent_48%)] p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]",
      "game-modal":
        "flex min-h-full flex-col gap-1.5 rounded-sm border border-white/10 bg-black/12 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export const sidebarHeaderVariants = cva("", {
  variants: {
    variant: {
      default:
        "shrink-0 border-b border-border/25 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_34%,transparent),transparent)] px-3.5 pb-4 pt-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
      mobile:
        "shrink-0 border-b border-border/25 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_34%,transparent),transparent)] px-3.5 pb-4 pt-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
      "game-modal":
        "shrink-0 border-b border-white/10 bg-black/10 px-3.5 pb-3 pt-3.5",
    },
    collapsed: {
      true: "flex min-h-0 flex-1 flex-col pb-0",
      false: "",
    },
  },
  compoundVariants: [
    {
      variant: "default",
      collapsed: true,
      className:
        "border-b border-border/25 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_34%,transparent),transparent)] px-3.5 pt-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
    },
  ],
  defaultVariants: {
    variant: "default",
    collapsed: false,
  },
});

export const sidebarFooterVariants = cva(
  "relative z-10 mt-auto flex shrink-0 justify-end border-t border-border/25 bg-[linear-gradient(0deg,color-mix(in_srgb,var(--card)_34%,transparent),transparent)] px-3.5 pb-3.5 pt-2 shadow-[inset_0_-1px_0_rgba(255,255,255,0.03)]",
);

export const sidebarControlButtonClassName =
  "h-11 w-11 rounded-sm border border-border/32 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_84%,transparent),color-mix(in_srgb,var(--bg)_95%,transparent))] text-muted-strong shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_14px_20px_-18px_rgba(15,23,42,0.14)] backdrop-blur-md transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-border/46 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_90%,transparent),color-mix(in_srgb,var(--bg)_97%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_16px_22px_-18px_rgba(15,23,42,0.16)] active:scale-95 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_16px_24px_-20px_rgba(0,0,0,0.24)]";

export const sidebarMobileHeaderBarClassName =
  "sticky top-0 z-10 flex items-center justify-between border-b border-border/40 bg-card/88 px-3.5 py-2.5 backdrop-blur-md";

export const sidebarCollapsedContentClassName =
  "flex min-h-0 w-full flex-1 flex-col items-center transform-gpu transition-[opacity,transform] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] motion-reduce:transform-none motion-reduce:transition-none";

export const sidebarContentLayerClassName =
  "flex min-h-0 flex-1 flex-col origin-left transform-gpu transition-[opacity,transform,filter] duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform,filter] motion-reduce:transform-none motion-reduce:transition-none";

export const sidebarContentOverlayLayerClassName =
  "pointer-events-none absolute inset-0 z-10 select-none";

export const sidebarCollapsedRailRootClassName =
  "flex min-h-0 w-full flex-1 flex-col items-center";

export const sidebarCollapsedRailActionWrapClassName =
  "flex flex-col items-center gap-3 py-1";

export const sidebarCollapsedRailListClassName =
  "custom-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto px-1 pb-2";

export const sidebarCollapsedActionButtonClassName = "h-11 w-11 rounded-sm";

export const sidebarCollapsedFallbackRootClassName =
  "!w-[7rem] !min-w-[7rem] rounded-tr-none xl:!w-[7rem] xl:!min-w-[7rem]";

export const sidebarCollapsedFallbackBodyClassName =
  "custom-scrollbar flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3 pt-2 [&_[data-sidebar-panel]]:min-h-0 [&_[data-sidebar-panel]]:gap-2 [&_[data-sidebar-panel]]:rounded-sm [&_[data-sidebar-panel]]:p-1.5 [&_[data-sidebar-filter-bar]]:hidden [&_[data-sidebar-section-label]]:hidden [&_[data-sidebar-section-header]]:hidden [&_[data-sidebar-toolbar-actions]]:hidden [&_[data-segmented-control]]:grid [&_[data-segmented-control]]:w-full [&_[data-segmented-control]]:max-w-none [&_[data-segmented-control]]:grid-cols-1 [&_[data-segmented-control]]:border-transparent [&_[data-segmented-control]]:bg-transparent [&_[data-segmented-control]]:p-0 [&_[data-segmented-control-button]]:w-full [&_[data-segmented-control-button]]:justify-center [&_[data-segmented-control-button]]:px-2.5 [&_[data-segmented-control-button]]:py-2.5 [&_[data-segmented-control-button]]:text-xs-tight [&_[data-sidebar-item]]:rounded-sm [&_[data-sidebar-item]]:px-2.5 [&_[data-sidebar-item]]:py-2.5 [&_[data-sidebar-item]]:gap-2 [&_[data-sidebar-item]]:items-center [&_[data-sidebar-item]]:justify-center [&_[data-sidebar-item]>div.absolute]:hidden [&_[data-sidebar-item-button]]:w-full [&_[data-sidebar-item-button]]:flex-col [&_[data-sidebar-item-button]]:items-center [&_[data-sidebar-item-button]]:justify-center [&_[data-sidebar-item-button]]:gap-2 [&_[data-sidebar-item-body]]:flex [&_[data-sidebar-item-body]]:w-full [&_[data-sidebar-item-body]]:flex-col [&_[data-sidebar-item-body]]:items-center [&_[data-sidebar-item-body]]:text-center [&_[data-sidebar-item-body]>*+*]:hidden [&_[data-sidebar-item-title]]:line-clamp-2 [&_[data-sidebar-item-title]]:text-center [&_[data-sidebar-item-title]]:text-xs-tight [&_[data-sidebar-item-title]]:leading-tight [&_[data-sidebar-item-description]]:hidden [&_[data-sidebar-item-icon]]:mx-auto [&_[data-sidebar-item-icon]]:mt-0 [&_[data-sidebar-item-action]]:hidden [&_.grid]:grid-cols-1 [&_.grid]:gap-2 [&_button]:min-h-11";

export const sidebarMetaClassName = "mt-1.5 text-xs text-muted";

export const sidebarFilterBarClassName =
  "flex w-full min-w-0 items-center gap-2";

export const sidebarFilterPrimaryClassName = "min-w-0 flex-1";

export const sidebarFilterActionsClassName = "flex shrink-0 items-center gap-2";

export const sidebarFilterButtonClassName =
  "h-10 w-10 shrink-0 rounded-sm border-border/60 bg-card/88 shadow-sm";

export const sidebarBodyClassName =
  "flex min-h-0 flex-1 flex-col overflow-hidden transform-gpu transition-[opacity,transform] duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[opacity,transform] motion-reduce:transform-none motion-reduce:transition-none";

export const sidebarHeaderStackClassName =
  "space-y-2.5 transform-gpu transition-[opacity,transform] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transform-none motion-reduce:transition-none";
