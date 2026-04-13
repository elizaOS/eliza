import { Button } from "@elizaos/app-core";
import { AlertTriangle } from "lucide-react";
import type { CSSProperties } from "react";
import { SHELL_EXPANDED_BUTTON_CLASSNAME } from "@elizaos/app-companion";

const CLOUD_STATUS_BUTTON_STYLE = {
  clipPath: "none",
  WebkitClipPath: "none",
  touchAction: "manipulation",
} as const;

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
      text: t("logsview.Error"),
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
  _appearance: CloudStatusBadgeProps["appearance"],
): CSSProperties {
  // The badge now only renders for warning/error/low-credits states.
  const toneVar = kind === "error" ? "var(--danger)" : "var(--warn)";
  return {
    borderColor: `color-mix(in srgb, ${toneVar} 34%, var(--border))`,
    color: `color-mix(in srgb, var(--text-strong) 78%, ${toneVar} 22%)`,
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

  return (
    <Button
      variant="outline"
      data-testid={dataTestId}
      data-status={status.kind}
      className={`${SHELL_EXPANDED_BUTTON_CLASSNAME} shrink-0 gap-1.5 px-3.5 leading-none no-underline ${
        appearance === "shell"
          ? "text-sm font-medium"
          : "text-xs-tight font-mono sm:text-xs"
      } ${compactOnMobile ? "max-[380px]:w-11 max-[380px]:justify-center max-[380px]:px-0" : ""}`}
      aria-label={status.title}
      title={status.title}
      onClick={onClick}
      style={{ ...CLOUD_STATUS_BUTTON_STYLE, ...toneStyle }}
    >
      <AlertTriangle className="pointer-events-none h-3.5 w-3.5 shrink-0" />
      <span
        className={`pointer-events-none leading-none ${compactOnMobile ? "max-[380px]:hidden" : ""}`}
      >
        {status.text}
      </span>
    </Button>
  );
}
