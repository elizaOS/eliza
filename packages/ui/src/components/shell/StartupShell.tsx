import type { ReactNode } from "react";
import { getBootConfig } from "../../config/boot-config-store";
import { ElizaMark } from "../brand/eliza-mark";
import { BootstrapStep } from "../setup/BootstrapStep";
import { PairingView } from "./PairingView";
import { StartupFailureView } from "./StartupFailureView";
import type { StartupShellProps } from "./startup-shell-types";

const FONT = "'Poppins', Arial, system-ui, sans-serif";

// Brand surface for the startup splash: the active theme's accent (the
// elizaOS accent by default) with its readable foreground. Whitelabel seam —
// no hardcoded brand color.
const BRAND_SURFACE =
  "bg-[var(--accent,#FF5800)] text-[var(--accent-foreground,#fff)]";

function brandName(): string {
  return getBootConfig().branding?.appName ?? "elizaOS";
}

// Host-overridable brand glyph (whitelabel seam); falls back to the elizaOS mark.
function BrandMark(props: { className?: string }) {
  const Mark = getBootConfig().brandMark ?? ElizaMark;
  return <Mark {...props} />;
}

export function StartupShell({ view, firstRun, onRetry }: StartupShellProps) {
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

  if (view.kind === "first-run") {
    return <StartupFirstRunBackground>{firstRun}</StartupFirstRunBackground>;
  }

  if (view.kind === "none") {
    return null;
  }

  return <StartupLoading phase={view.phase} status={view.status} />;
}

function StartupFirstRunBackground({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="startup-first-run-background"
      className={`fixed inset-0 overflow-hidden ${BRAND_SURFACE}`}
      style={{ fontFamily: FONT }}
    >
      {children}
    </div>
  );
}

function StartupLoading(props: { phase: string; status: string }) {
  return (
    <div
      data-testid="startup-shell-loading"
      data-startup-phase={props.phase}
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`fixed inset-0 flex items-center justify-center overflow-hidden ${BRAND_SURFACE}`}
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
