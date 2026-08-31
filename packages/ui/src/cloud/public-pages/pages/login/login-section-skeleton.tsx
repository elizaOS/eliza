/**
 * Geometry-reserving placeholders for the login card's transient states. The
 * sign-in card passes through several states before the final option stack —
 * lazy section-chunk load, provider discovery, OAuth-callback completion — and
 * each used to render a short spinner block, so the card visibly jumped when
 * the real options arrived (#18256). Every placeholder here mirrors the final
 * stack's exact row structure (44px `h-touch` rows, identical gaps and
 * responsive grids), so production-default loading stays visually stable.
 *
 * The skeleton mirrors the fully-enabled provider layout (email field,
 * passkey/magic-link row, and the six-action provider icon grid) — the effective
 * shape of the production tenant. Provider policies are discovered at runtime,
 * so tenants that disable SMS or expose a seventh method resize once when that
 * authoritative configuration arrives.
 */

import type { ReactNode } from "react";
import { Skeleton } from "../../../../components/ui/skeleton";

function GhostRow({
  animated,
  className,
}: {
  animated: boolean;
  className: string;
}) {
  return (
    <Skeleton
      className={`${animated ? "motion-reduce:animate-none " : "animate-none "}${className}`}
    />
  );
}

/**
 * Structural ghost of the fully-enabled sign-in option stack. `animated`
 * renders the visible pulsing skeleton; pass `false` for an invisible sizing
 * ghost (see {@link ReservedLoginFrame}).
 */
export function LoginOptionsSkeleton({
  animated = true,
}: {
  animated?: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Phone field, SMS action, and phone-to-email divider. */}
      <div className="flex h-11 overflow-hidden">
        <GhostRow animated={animated} className="h-touch w-24" />
        <GhostRow animated={animated} className="h-touch min-w-0 flex-1" />
      </div>
      <GhostRow animated={animated} className="h-touch w-full" />
      <GhostRow animated={animated} className="h-px w-full" />
      {/* Email input. Its accessible label is visually hidden. */}
      <GhostRow animated={animated} className="h-touch w-full" />
      {/* Passkey / Magic Link row. */}
      <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
        <GhostRow animated={animated} className="h-touch flex-1" />
        <GhostRow animated={animated} className="h-touch flex-1" />
      </div>
      {/* Unlabelled divider between direct and federated sign-in. */}
      <GhostRow animated={animated} className="h-px w-full" />
      {/* OAuth, Telegram, and Wallet: two rows of compact icon controls. */}
      <div
        data-testid="login-provider-skeleton-grid"
        className="grid grid-cols-[repeat(3,2.75rem)] justify-center gap-x-4 gap-y-2"
      >
        {["google", "discord", "github", "twitter", "telegram", "wallet"].map(
          (provider) => (
            <GhostRow key={provider} animated={animated} className="size-11" />
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Reserves the final option stack's footprint for spinner-style states
 * (completing sign-in, redirecting) by stacking the state's content over an
 * invisible {@link LoginOptionsSkeleton} in the same grid cell, so the card
 * cannot shrink while the state is showing and cannot jump when it resolves.
 */
export function ReservedLoginFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid">
      <div
        aria-hidden="true"
        data-testid="login-reserved-geometry-ghost"
        className="invisible col-start-1 row-start-1"
      >
        <LoginOptionsSkeleton animated={false} />
      </div>
      <div className="col-start-1 row-start-1 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}
