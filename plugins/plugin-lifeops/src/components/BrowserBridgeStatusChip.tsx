import { client } from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import {
  type BrowserBridgeReadinessState,
  resolveBrowserBridgeReadiness,
} from "../lifeops/browser-readiness.js";
import { buildLifeOpsHash } from "../lifeops-route.js";

const BROWSER_SETUP_PANEL_ID = "lifeops-browser-setup";

type ChipState = BrowserBridgeReadinessState | "error";

interface BrowserBridgeStatusChipProps {
  onNavigate: (section: LifeOpsSection) => void;
}

interface ChipDescriptor {
  label: string;
  dotClass: string;
  borderClass: string;
}

const CHIP_DESCRIPTORS: Record<ChipState, ChipDescriptor> = {
  ready: {
    label: "Browser ready",
    dotClass: "bg-emerald-400",
    borderClass: "border-emerald-500/30",
  },
  disabled: {
    label: "Browser tracking off",
    dotClass: "bg-muted",
    borderClass: "border-border/24",
  },
  tracking_off: {
    label: "Browser tracking off",
    dotClass: "bg-muted",
    borderClass: "border-border/24",
  },
  paused: {
    label: "Browser paused",
    dotClass: "bg-amber-300",
    borderClass: "border-amber-500/30",
  },
  control_disabled: {
    label: "Browser control off",
    dotClass: "bg-amber-300",
    borderClass: "border-amber-500/30",
  },
  no_companion: {
    label: "Browser setup needed",
    dotClass: "bg-muted",
    borderClass: "border-border/24",
  },
  stale: {
    label: "Browser offline",
    dotClass: "bg-amber-300",
    borderClass: "border-amber-500/30",
  },
  permission_blocked: {
    label: "Browser permissions needed",
    dotClass: "bg-rose-400",
    borderClass: "border-rose-500/30",
  },
  error: {
    label: "Browser status unavailable",
    dotClass: "bg-rose-400",
    borderClass: "border-rose-500/30",
  },
};

function focusBrowserSetupPanel(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  const focus = () => {
    document
      .getElementById(BROWSER_SETUP_PANEL_ID)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focus);
  } else {
    window.setTimeout(focus, 0);
  }
}

function writeSetupHash(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const nextHash = buildLifeOpsHash(window.location.hash, {
      eventId: null,
      messageId: null,
      section: "setup",
    });
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  } catch {
    window.location.hash = "lifeops.section=setup";
  }
}

export function BrowserBridgeStatusChip({
  onNavigate,
}: BrowserBridgeStatusChipProps) {
  const [state, setState] = useState<ChipState>("no_companion");
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [settingsResult, companionsResult] = await Promise.all([
        client.getBrowserBridgeSettings(),
        client.listBrowserBridgeCompanions(),
      ]);
      setState(
        resolveBrowserBridgeReadiness(
          settingsResult.settings,
          companionsResult.companions,
        ).state,
      );
    } catch {
      setState("error");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    function handleVisibility(): void {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibility);
  }, [refresh]);

  const descriptor = CHIP_DESCRIPTORS[state];
  const handleClick = useCallback(() => {
    onNavigate("setup");
    writeSetupHash();
    focusBrowserSetupPanel();
  }, [onNavigate]);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={descriptor.label}
      title={descriptor.label}
      data-testid="lifeops-overview-browser-chip"
      data-state={state}
      data-loaded={loaded ? "1" : "0"}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-bg/30 transition-colors hover:bg-bg/50 ${descriptor.borderClass}`}
    >
      <span
        className={`h-2 w-2 rounded-full ${descriptor.dotClass}`}
        aria-hidden
      />
    </button>
  );
}
