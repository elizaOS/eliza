export const SHELL_CONTROL_BASE_CLASSNAME =
  "border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt";

export const SHELL_ICON_BUTTON_CLASSNAME = `inline-flex h-11 w-11 min-h-touch min-w-touch items-center justify-center rounded-xl ${SHELL_CONTROL_BASE_CLASSNAME}`;

export const SHELL_EXPANDED_BUTTON_CLASSNAME = `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-xl px-3.5 py-0 ${SHELL_CONTROL_BASE_CLASSNAME}`;

export const SHELL_SEGMENTED_CONTROL_CLASSNAME =
  "inline-flex items-center gap-0.5 rounded-xl border border-border/45 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_52%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] p-0.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_rgba(3,5,10,0.12)] ring-1 ring-inset ring-white/6 backdrop-blur-xl";

export const SHELL_SEGMENT_ACTIVE_CLASSNAME =
  "border-[color:color-mix(in_srgb,var(--accent)_34%,var(--border))] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--accent)_20%,var(--card)),color-mix(in_srgb,var(--accent)_10%,var(--bg)))] text-[color:color-mix(in_srgb,var(--text-strong)_78%,var(--accent)_22%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_8px_20px_rgba(3,5,10,0.12)]";

export const SHELL_SEGMENT_INACTIVE_CLASSNAME =
  "border border-transparent bg-transparent text-muted-strong hover:border-border/60 hover:bg-bg-hover/80 hover:text-txt";

export const HEADER_BUTTON_STYLE = {
  clipPath: "none",
  WebkitClipPath: "none",
  touchAction: "manipulation",
} as const;
