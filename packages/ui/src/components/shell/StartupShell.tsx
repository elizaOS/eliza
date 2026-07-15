/**
 * Composes the startup shell around boot, retry, pairing, and handoff states
 * before the app is ready.
 */
import { type ReactNode, useEffect } from "react";
import { getBootConfig } from "../../config/boot-config-store";
import { markStartup } from "../../state/startup-telemetry";
import { ElizaMark } from "../brand/eliza-mark";
import { BootstrapStep } from "../setup/BootstrapStep";
import { PairingView } from "./PairingView";
import { StartupFailureView } from "./StartupFailureView";
import type { StartupShellProps } from "./startup-shell-types";

// The startup surface can paint before the bundled Poppins face is ready. An
// OS-resident stack keeps the centered brand row fixed through that handoff.
const FONT = "Arial, system-ui, sans-serif";

// Launch surface for the startup splash + loading: it must match the default
// HOME background base (#000000 = DEFAULT_BACKGROUND_COLOR, the black field
// under the home ShaderBackground's orange ember glow) so boot/launch flows
// seamlessly into the home with no flash (#9565). NOTE: this is NOT `--bg` —
// the theme background is white/black (`:root`/`.dark`) or the brand orange
// #ff8a24 (`.theme-app`), none of which is the home shader base — so a
// dedicated launch token is used. Whitelabel seam: hosts override
// `--launch-bg` / `--accent-foreground`; the literal fallbacks are the
// elizaOS defaults.
const LAUNCH_SURFACE =
  "bg-[var(--launch-bg,#000000)] text-[var(--accent-foreground,#fff)]";

function brandName(): string {
  return getBootConfig().branding?.appName ?? "elizaOS";
}

function startupStatusLabel(status: string): string {
  return status.replace(/(?:\.{3}|…)\s*$/u, "").trim();
}

// Host-overridable brand glyph (whitelabel seam); falls back to the elizaOS mark.
function BrandMark(props: { className?: string }) {
  const Mark = getBootConfig().brandMark ?? ElizaMark;
  return <Mark {...props} />;
}

export function StartupShell({ view, onRetry }: StartupShellProps) {
  // Unconditional mount checkpoint: unlike the visible-paint mark below, this
  // fires as soon as the shell mounts (including a ready boot that never needs
  // the React splash), so the boot-trace harness
  // (capture-startup-trace.mjs) always has a reachable renderer-only mark.
  // markStartup dedupes by name, so re-renders keep it single.
  useEffect(() => {
    markStartup("startup-shell:mounted", { view: view.kind });
  }, [view.kind]);

  // Renderer cold-start checkpoint (#9565): "first paint" of the startup front
  // door = the moment visible startup UI actually renders. Loading paints
  // immediately because it replaces the host's identical preboot lockup; a
  // delay would erase that lockup and expose a blank frame between renderers.
  // The "none" (ready) branch renders null and must not count as a paint.
  const painting = view.kind !== "none";
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
    return <StartupLoading phase={view.phase} status={view.status} />;
  }

  // kind === "none": app is ready, the startup shell renders nothing.
  return null;
}

/**
 * Branded loading lockup shared by the app's root Suspense handoff and the
 * startup state machine so replacing the static preboot DOM never blanks or
 * changes geometry while lazy UI chunks resolve.
 */
export function StartupLoading(props: { phase: string; status: string }) {
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
      <div className="relative z-10 flex w-full max-w-[24rem] flex-col items-center gap-4 px-6 text-center">
        <div
          data-testid="startup-brand-lockup"
          className="flex items-center justify-center gap-3"
        >
          <BrandMark className="h-12 w-12" />
          <span className="text-4xl font-medium leading-none tracking-normal">
            {brandName()}
          </span>
        </div>

        <p className="min-h-6 text-base font-medium leading-6 tracking-[0.01em] text-white/60 shimmer [--shimmer-color:rgba(255,255,255,1)] [--shimmer-duration:1.8s] [--shimmer-spread:calc(2.5ch+32px)] motion-reduce:shimmer-none motion-reduce:animate-none">
          {startupStatusLabel(props.status)}
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
