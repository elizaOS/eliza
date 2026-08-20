/**
 * Geometry-reserving placeholders for the login card's transient states. The
 * sign-in card passes through several states before the final option stack —
 * lazy section-chunk load, provider discovery, OAuth-callback completion — and
 * each used to render a short spinner block, so the card visibly jumped when
 * the real options arrived (#18256). Every placeholder here mirrors the final
 * stack's exact row structure (44px `h-touch` rows, identical gaps and
 * responsive grids), so the card keeps one height and position across states.
 *
 * The skeleton mirrors the fully-enabled provider layout (email field,
 * passkey/magic-link row, OAuth grid, wallet grid) — the effective shape of the
 * production tenants. A tenant with fewer providers gets a loading card
 * slightly taller than its final form rather than a mid-load jump.
 */

import type { ReactNode } from "react";

function GhostRow({
  animated,
  className,
}: {
  animated: boolean;
  className: string;
}) {
  return (
    <div
      className={`rounded-md ${
        animated ? "animate-pulse bg-bg-muted motion-reduce:animate-none " : ""
      }${className}`}
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
      {/* Email label + input (label text-sm = 20px, input resolves to 44px). */}
      <div className="space-y-2">
        <GhostRow animated={animated} className="h-5 w-16" />
        <GhostRow animated={animated} className="h-touch w-full" />
      </div>
      {/* Passkey / Magic Link row. */}
      <div className="flex gap-2">
        <GhostRow animated={animated} className="h-touch flex-1" />
        <GhostRow animated={animated} className="h-touch flex-1" />
      </div>
      {/* Signup hint line (text-xs = 16px). */}
      <GhostRow animated={animated} className="mx-auto h-4 w-3/4" />
      {/* "or continue with" divider row. */}
      <GhostRow animated={animated} className="mx-auto h-4 w-32" />
      {/* OAuth grid: one compact row on wide cards, stacked on mobile. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <GhostRow animated={animated} className="h-touch" />
        <GhostRow animated={animated} className="h-touch" />
        <GhostRow animated={animated} className="h-touch" />
      </div>
      {/* "or sign in with a wallet" divider row. */}
      <GhostRow animated={animated} className="mx-auto h-4 w-32" />
      {/* EVM + Solana wallet row. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <GhostRow animated={animated} className="h-touch" />
        <GhostRow animated={animated} className="h-touch" />
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
