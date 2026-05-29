import type { ReactNode } from "react";
import { BootstrapStep } from "../setup/BootstrapStep";
import { PairingView } from "./PairingView";
import { StartupFailureView } from "./StartupFailureView";
import type { StartupShellProps } from "./startup-shell-types";

const FONT = "'Poppins', Arial, system-ui, sans-serif";

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
    return <>{firstRun}</>;
  }

  if (view.kind === "none") {
    return null;
  }

  return <StartupLoading phase={view.phase} status={view.status} />;
}

function StartupLoading(props: { phase: string; status: string }) {
  return (
    <div
      data-testid="startup-shell-loading"
      data-startup-phase={props.phase}
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 flex items-center justify-center overflow-hidden bg-[#ff5800] text-white"
      style={{ fontFamily: FONT }}
    >
      <div className="relative z-10 flex w-full max-w-[24rem] flex-col items-center gap-5 px-6 text-center">
        <div className="flex items-center justify-center gap-3">
          <span
            aria-hidden="true"
            className="h-12 w-12 bg-white"
            style={{
              WebkitMaskImage: "url(./brand/favicons/favicon.svg)",
              maskImage: "url(./brand/favicons/favicon.svg)",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
              WebkitMaskSize: "contain",
              maskSize: "contain",
            }}
          />
          <span className="text-4xl font-medium leading-none tracking-normal">
            eliza
          </span>
        </div>

        <p
          style={{ fontFamily: FONT }}
          className="min-h-5 text-sm uppercase tracking-wide text-white/85 animate-pulse motion-reduce:animate-none"
        >
          {props.status}
        </p>
      </div>
    </div>
  );
}

function BootstrapGateShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-full w-full flex-col bg-[#F7F9FF] text-[#0B35F1]">
      <div className="relative z-10 flex flex-1 items-center justify-center px-4 pb-[max(1.5rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)_+_3.75rem)] sm:px-6 md:px-8">
        <div className="flex w-full max-w-[32rem] flex-col items-center gap-4">
          {children}
        </div>
      </div>
    </div>
  );
}
