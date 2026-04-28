import { client } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";
import type { BrowserBridgeCompanionStatus } from "../contracts/index.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";

const RECENT_CONTACT_WINDOW_MS = 5 * 60_000;

type ChipState = "connected" | "stale" | "needs-setup";

interface BrowserBridgeStatusChipProps {
  onNavigate: (section: LifeOpsSection) => void;
}

interface ChipDescriptor {
  label: string;
  dotClass: string;
  borderClass: string;
}

const CHIP_DESCRIPTORS: Record<ChipState, ChipDescriptor> = {
  connected: {
    label: "Browser connected",
    dotClass: "bg-emerald-400",
    borderClass: "border-emerald-500/30",
  },
  stale: {
    label: "Browser offline",
    dotClass: "bg-amber-300",
    borderClass: "border-amber-500/30",
  },
  "needs-setup": {
    label: "Browser setup needed",
    dotClass: "bg-muted",
    borderClass: "border-border/24",
  },
};

function computeChipState(
  companions: BrowserBridgeCompanionStatus[],
): ChipState {
  if (companions.length === 0) return "needs-setup";
  const now = Date.now();
  const hasRecent = companions.some((companion) => {
    if (!companion.lastSeenAt) return false;
    const seenAt = Date.parse(companion.lastSeenAt);
    if (!Number.isFinite(seenAt)) return false;
    return now - seenAt < RECENT_CONTACT_WINDOW_MS;
  });
  return hasRecent ? "connected" : "stale";
}

export function BrowserBridgeStatusChip({
  onNavigate,
}: BrowserBridgeStatusChipProps) {
  const [state, setState] = useState<ChipState>("needs-setup");
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const result = await client.listBrowserBridgeCompanions();
    setState(computeChipState(result.companions));
    setLoaded(true);
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
    if (typeof window !== "undefined") {
      try {
        window.location.hash = `${window.location.hash.split("?")[0] || "#"}#browser-bridge`;
      } catch {
        // Hash assignment can fail in restricted environments — non-fatal.
      }
    }
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
