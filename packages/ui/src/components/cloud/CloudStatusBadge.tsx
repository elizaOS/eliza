import type { CSSProperties } from "react";
import { Button } from "../ui/button";

type CloudHeaderStatusKind =
  | "error"
  | "warning"
  | "low-credits"
  | "regular-credits";

interface ResolveCloudStatusBadgeStateArgs {
  connected: boolean;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
  authRejected: boolean;
  creditsError?: string | null;
  t: (key: string) => string;
}

interface CloudStatusBadgeState {
  kind: CloudHeaderStatusKind;
  text: string;
  title: string;
}

export interface CloudStatusBadgeProps {
  connected: boolean;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
  authRejected: boolean;
  creditsError?: string | null;
  compactOnMobile?: boolean;
  appearance?: "default" | "shell";
  t: (key: string) => string;
  onClick: () => void;
  dataTestId?: string;
}

function trimTrailingZeroes(value: string): string {
  return value.replace(/\.0+$|(\.\d*[1-9])0+$/, "$1");
}

export function formatCompactCloudCredits(balance: number): string {
  const absoluteBalance = Math.abs(balance);
  const sign = balance < 0 ? "-" : "";

  if (absoluteBalance >= 1_000_000) {
    return `${sign}$${trimTrailingZeroes((absoluteBalance / 1_000_000).toFixed(1))}m`;
  }

  if (absoluteBalance >= 1_000) {
    return `${sign}$${trimTrailingZeroes((absoluteBalance / 1_000).toFixed(1))}k`;
  }

  if (absoluteBalance >= 100) {
    return `${sign}$${absoluteBalance.toFixed(0)}`;
  }

  if (absoluteBalance >= 10) {
    return `${sign}$${trimTrailingZeroes(absoluteBalance.toFixed(1))}`;
  }

  return `${sign}$${trimTrailingZeroes(absoluteBalance.toFixed(2))}`;
}

export function resolveCloudStatusBadgeState(
  args: ResolveCloudStatusBadgeStateArgs,
): CloudStatusBadgeState | null {
  const {
    connected,
    credits,
    creditsLow,
    creditsCritical,
    authRejected,
    creditsError,
    t,
  } = args;

  if (!connected) {
    return null;
  }

  if (authRejected) {
    return {
      kind: "error",
      text: t("common.error"),
      title: t("header.elizaCloudAuthRejected"),
    };
  }

  if (typeof creditsError === "string" && creditsError.trim()) {
    return {
      kind: "warning",
      text: t("logsview.Warn"),
      title: creditsError.trim(),
    };
  }

  if (typeof credits === "number") {
    const isLowCredits = creditsCritical || creditsLow;
    // Only show the badge for low/critical credits — a healthy balance
    // doesn't need a header indicator.
    if (!isLowCredits) return null;
    const formattedBalance = formatCompactCloudCredits(credits);
    return {
      kind: "low-credits",
      text: formattedBalance,
      title: `${t("header.CloudCreditsBalanc")}: ${formattedBalance}`,
    };
  }

  return {
    kind: "warning",
    text: t("logsview.Warn"),
    title: t("header.CloudCreditsBalanc"),
  };
}

function resolveCloudStatusToneStyle(
  kind: CloudHeaderStatusKind,
  appearance: CloudStatusBadgeProps["appearance"],
): CSSProperties {
  const toneVar = kind === "error" ? "var(--danger)" : "var(--warn)";
  if (appearance === "shell") {
    return {
      borderColor: `color-mix(in srgb, ${toneVar} 34%, var(--border))`,
      color: `color-mix(in srgb, var(--text-strong) 78%, ${toneVar} 22%)`,
    };
  }
  return {
    color: `color-mix(in srgb, var(--text-strong) 70%, ${toneVar} 30%)`,
  };
}

export function CloudStatusBadge(props: CloudStatusBadgeProps) {
  const {
    connected,
    credits,
    creditsLow,
    creditsCritical,
    authRejected,
    creditsError,
    compactOnMobile = false,
    appearance = "default",
    t,
    onClick,
    dataTestId,
  } = props;

  const status = resolveCloudStatusBadgeState({
    connected,
    credits,
    creditsLow,
    creditsCritical,
    authRejected,
    creditsError,
    t,
  });

  if (!status) {
    return null;
  }

  const toneStyle = resolveCloudStatusToneStyle(status.kind, appearance);

  const buttonClassName =
    appearance === "shell"
      ? `inline-flex h-11 min-h-touch min-w-touch items-center justify-center rounded-xl px-3.5 py-0 border border-border/42 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] text-txt shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_14px_32px_rgba(3,5,10,0.14)] ring-1 ring-inset ring-white/6 backdrop-blur-xl supports-[backdrop-filter]:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_62%,transparent),color-mix(in_srgb,var(--bg)_34%,transparent))] transition-[border-color,background-color,color,transform,box-shadow] duration-200 hover:border-accent/55 hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_78%,transparent),color-mix(in_srgb,var(--bg-hover)_52%,transparent))] hover:text-txt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_18px_36px_rgba(3,5,10,0.18)] active:scale-[0.98] disabled:active:scale-100 disabled:hover:border-border/42 disabled:hover:bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_72%,transparent),color-mix(in_srgb,var(--bg)_44%,transparent))] disabled:hover:text-txt shrink-0 gap-1.5 leading-none no-underline text-sm font-medium`
      : `inline-flex h-[2.375rem] min-h-[2.375rem] shrink-0 items-center gap-1.5 rounded-md border border-transparent !bg-transparent px-2.5 leading-none text-muted shadow-none ring-0 transition-colors duration-150 hover:!bg-transparent hover:text-txt active:!bg-transparent text-xs-tight font-mono sm:text-xs`;

  return (
    <Button
      variant={appearance === "shell" ? "outline" : "ghost"}
      data-testid={dataTestId}
      data-status={status.kind}
      className={`${buttonClassName} ${compactOnMobile ? "max-[380px]:w-[2.375rem] max-[380px]:min-w-[2.375rem] max-[380px]:justify-center max-[380px]:px-0" : ""}`}
      aria-label={status.title}
      title={status.title}
      onClick={onClick}
      style={{
        clipPath: "none",
        WebkitClipPath: "none",
        touchAction: "manipulation",
        ...toneStyle,
      }}
    >
      <span
        className={`pointer-events-none leading-none ${compactOnMobile ? "max-[380px]:hidden" : ""}`}
      >
        {status.text}
      </span>
    </Button>
  );
}
