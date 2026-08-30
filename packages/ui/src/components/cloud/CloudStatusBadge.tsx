/**
 * Header status badge for the Eliza Cloud connection. Renders only when there is
 * something worth surfacing — auth rejection, a credits-fetch error, or a
 * low/critical credit balance — and stays hidden for a healthy balance. Balances
 * are formatted compactly ($1.2k / $3.4m) for the header. The `shell` appearance
 * matches the app shell's chrome; the default is a lighter inline button.
 */
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

function formatCompactCloudCredits(balance: number): string {
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

function resolveCloudStatusBadgeState(
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

  const variant =
    status.kind === "error"
      ? appearance === "shell"
        ? "dangerOutline"
        : "dangerGhost"
      : "warningOutline";

  return (
    <Button
      variant={variant}
      size={appearance === "shell" ? "touch" : "pageDrawerTrigger"}
      data-testid={dataTestId}
      data-status={status.kind}
      className={`shrink-0 ${compactOnMobile ? "max-[380px]:w-[2.375rem] max-[380px]:min-w-[2.375rem]" : ""}`}
      aria-label={status.title}
      title={status.title}
      onClick={onClick}
      style={{
        clipPath: "none",
        WebkitClipPath: "none",
        touchAction: "manipulation",
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
