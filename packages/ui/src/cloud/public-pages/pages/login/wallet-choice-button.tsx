/**
 * Canonical wallet-network choice used by hosted sign-in.
 *
 * The chooser supplies the network-specific behavior while this adapter keeps
 * its icon, loading state, and action affordance consistent across networks.
 */

import { ChevronRight } from "lucide-react";
import { Button } from "../../../../components/ui/button";

export type WalletChoiceKind = "ethereum" | "solana";

export function WalletChoiceButton({
  kind,
  label,
  disabled,
  loading = false,
  onClick,
}: {
  kind: WalletChoiceKind;
  label: string;
  disabled: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outlineMuted"
      size="touch"
      align="start"
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className="group hosted-signin-focus-emphasis w-full"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface text-txt-strong"
      >
        {kind === "ethereum" ? <EthereumMark /> : <SolanaMark />}
      </span>
      <span className="min-w-0 flex-1 text-sm font-semibold text-txt-strong">
        {label}
      </span>
      {loading ? (
        <span
          aria-hidden="true"
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70 motion-reduce:animate-none"
        />
      ) : (
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-4 text-muted transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:text-txt"
        />
      )}
    </Button>
  );
}

function EthereumMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.75 6.4 12 12 15.2 17.6 12 12 2.75Z" fill="currentColor" />
      <path
        d="m6.4 13.1 5.6 8.15 5.6-8.15-5.6 3.2-5.6-3.2Z"
        fill="currentColor"
        opacity="0.68"
      />
    </svg>
  );
}

function SolanaMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.1 4.5h12.8l-2.5 3H3.6l2.5-3Z" fill="currentColor" />
      <path
        d="M3.6 10.5h12.8l2.5 3H6.1l-2.5-3Z"
        fill="currentColor"
        opacity="0.82"
      />
      <path
        d="M6.1 16.5h12.8l-2.5 3H3.6l2.5-3Z"
        fill="currentColor"
        opacity="0.64"
      />
    </svg>
  );
}
