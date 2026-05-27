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
      className="fixed inset-0 flex items-center justify-center overflow-hidden bg-[#F7F9FF] text-[#0B35F1]"
      style={{ fontFamily: FONT }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/25 backdrop-blur-[18px]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.34) 100%)",
        }}
      />
      <div className="relative z-10 flex w-full max-w-[24rem] flex-col items-center gap-5 px-6 text-center">
        <div className="flex items-center justify-center gap-3">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-white shadow-[0_18px_48px_rgba(11,53,241,0.14)] ring-1 ring-[#0B35F1]/15">
            <img
              src="./brand/favicons/favicon.svg"
              alt=""
              aria-hidden="true"
              className="h-9 w-9"
            />
          </span>
          <span className="text-4xl font-medium leading-none tracking-normal">
            elizaOS
          </span>
        </div>

        <p
          style={{ fontFamily: FONT }}
          className="min-h-5 text-sm text-[#0B35F1]/75 animate-pulse motion-reduce:animate-none"
        >
          {props.status}
        </p>
        <div className="flex w-full max-w-[18rem] flex-col gap-2" aria-hidden>
          <div className="h-2.5 w-full rounded-sm bg-[#0B35F1]/20 animate-pulse motion-reduce:animate-none" />
          <div className="h-2.5 w-3/4 self-center rounded-sm bg-[#0B35F1]/15 animate-pulse motion-reduce:animate-none" />
          <div className="h-2.5 w-1/2 self-center rounded-sm bg-[#0B35F1]/10 animate-pulse motion-reduce:animate-none" />
        </div>
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
