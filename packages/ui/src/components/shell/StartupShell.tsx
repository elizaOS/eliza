/**
 * Composes the startup shell around boot, retry, pairing, and handoff states
 * before the app is ready.
 */
import { type ReactNode, useEffect, useState } from "react";
import { getBootConfig } from "../../config/boot-config-store";
import { markStartup } from "../../state/startup-telemetry";
import { ElizaMark } from "../brand/eliza-mark";
import { BootstrapStep } from "../setup/BootstrapStep";
import { PairingView } from "./PairingView";
import { StartupFailureView } from "./StartupFailureView";
import type { StartupShellProps } from "./startup-shell-types";

const FONT = "'Poppins', Arial, system-ui, sans-serif";

// Launch surface for the startup splash + loading: it must match the default
// HOME background orange (#ef5a1f = DEFAULT_BACKGROUND_COLOR, the home
// ShaderBackground) so boot/launch flows seamlessly into the home with no
// orange→orange flash (#9565). NOTE: this is NOT `--bg` — the theme background
// is white/black (`:root`/`.dark`) or the brand orange #ff8a24 (`.theme-app`),
// none of which is the home shader color — so a dedicated launch token is used.
// Whitelabel seam: hosts override `--launch-bg` / `--accent-foreground`; the
// literal fallbacks are the elizaOS defaults.
const LAUNCH_SURFACE =
  "bg-[var(--launch-bg,#ef5a1f)] text-[var(--accent-foreground,#fff)]";

// A fast, already-cached boot flips the view through the loading state for only
// a few milliseconds before the app is ready. Painting the full-screen orange
// splash for those few ms and then ripping it away reads as a jarring flash. So
// the splash is gated behind a short delay: it renders ONLY once the loading
// state has persisted this long. A boot that becomes ready first never paints
// it. Error / pairing / bootstrap views are NOT gated — they are terminal or
// interactive states the user is meant to see immediately, not fast-flash cases.
// NOTE: during the ≤220ms null-render window the shell paints nothing — the
// host's FOUC guard painting `--launch-bg` is what keeps the screen non-blank.
export const STARTUP_SPLASH_DELAY_MS = 220;

/**
 * True only after `active` has stayed `true` continuously for `delayMs`.
 * Flips back to `false` the instant `active` goes `false`. The timer lives in
 * an effect (never at render time) so the render path stays deterministic and
 * the `audit:ui-determinism` gate stays green.
 */
function useDelayElapsed(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return elapsed;
}

function brandName(): string {
  return getBootConfig().branding?.appName ?? "elizaOS";
}

// Host-overridable brand glyph (whitelabel seam); falls back to the elizaOS mark.
function BrandMark(props: { className?: string }) {
  const Mark = getBootConfig().brandMark ?? ElizaMark;
  return <Mark {...props} />;
}

export function StartupShell({ view, onRetry }: StartupShellProps) {
  // The loading splash is delay-gated (see STARTUP_SPLASH_DELAY_MS): it renders
  // only once the loading state has persisted past the threshold, so a fast
  // cached boot that becomes ready first never flashes it.
  const splashElapsed = useDelayElapsed(
    view.kind === "loading",
    STARTUP_SPLASH_DELAY_MS,
  );

  // Unconditional mount checkpoint: unlike the gated first-paint mark below,
  // this fires as soon as the shell mounts (any view, including a fast boot
  // that never paints the splash), so the boot-trace harness
  // (capture-startup-trace.mjs) always has a reachable renderer-only mark.
  // markStartup dedupes by name, so re-renders keep it single.
  useEffect(() => {
    markStartup("startup-shell:mounted", { view: view.kind });
  }, [view.kind]);

  // Renderer cold-start checkpoint (#9565): "first paint" of the startup front
  // door = the moment visible startup UI actually renders. Error / pairing /
  // bootstrap paint immediately; the loading splash paints only once the delay
  // gate opens; the "none" (ready) branch renders null and must NOT count as a
  // startup-shell paint (nothing painted). markStartup dedupes by name, so the
  // first real paint wins.
  const painting =
    view.kind === "error" ||
    view.kind === "pairing" ||
    view.kind === "bootstrap" ||
    (view.kind === "loading" && splashElapsed);
  useEffect(() => {
    if (painting) {
      markStartup("startup-shell:first-paint", { view: view.kind });
    }
  }, [painting, view.kind]);

  if (view.kind === "error") {
    return <StartupFailureView error={view.error} onRetry={onRetry} />;
  }

  if (view.kind === "pairing") {
    return <PairingView />;
  }

  if (view.kind === "bootstrap") {
    return (
      <BootstrapGateShell>
        <BootstrapStep onAdvance={view.onAdvance} />
      </BootstrapGateShell>
    );
  }

  if (view.kind === "loading") {
    return splashElapsed ? (
      <StartupLoading phase={view.phase} status={view.status} />
    ) : null;
  }

  // kind === "none": app is ready, the startup shell renders nothing.
  return null;
}

function StartupLoading(props: { phase: string; status: string }) {
  return (
    <div
      data-testid="startup-shell-loading"
      data-startup-phase={props.phase}
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`fixed inset-0 flex items-center justify-center overflow-hidden ${LAUNCH_SURFACE}`}
      style={{ fontFamily: FONT }}
    >
      <div className="relative z-10 flex w-full max-w-[24rem] flex-col items-center gap-5 px-6 text-center">
        <div className="flex items-center justify-center gap-3">
          <BrandMark className="h-12 w-12" />
          <span className="text-4xl font-medium leading-none tracking-normal">
            {brandName()}
          </span>
        </div>

        <p
          style={{ fontFamily: FONT }}
          className="min-h-5 text-sm opacity-80 animate-pulse motion-reduce:animate-none"
        >
          {props.status}
        </p>
      </div>
    </div>
  );
}

function BootstrapGateShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full w-full flex-col bg-[#F7F6F4] text-[#1b1b1b]">
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 pb-[max(1.5rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)_+_3.75rem)] sm:px-6 md:px-8">
        <div className="flex w-full max-w-[32rem] flex-col items-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}
