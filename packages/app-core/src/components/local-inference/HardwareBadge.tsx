import type { HardwareProbe } from "../../api/client-local-inference";
import { bucketLabel } from "./hub-utils";

interface HardwareBadgeProps {
  hardware: HardwareProbe;
}

/**
 * Summary of the user's detected hardware with the recommended preset.
 * Sits above the catalog so users understand why certain models are
 * marked as tight/won't-fit.
 */
export function HardwareBadge({ hardware }: HardwareBadgeProps) {
  const gpuText = hardware.gpu
    ? `${hardware.gpu.backend.toUpperCase()} · ${hardware.gpu.totalVramGb.toFixed(1)} GB VRAM`
    : "CPU only";
  const chipLabel = hardware.appleSilicon ? "Apple Silicon" : hardware.arch;

  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-wrap items-center gap-4 text-sm">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Your device
        </div>
        <div className="font-medium">
          {hardware.totalRamGb.toFixed(0)} GB RAM · {hardware.cpuCores} cores ·{" "}
          {chipLabel}
        </div>
      </div>
      <div className="h-8 w-px bg-border" aria-hidden />
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          GPU
        </div>
        <div className="font-medium">{gpuText}</div>
      </div>
      <div className="h-8 w-px bg-border" aria-hidden />
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Recommended preset
        </div>
        <div className="font-medium">
          {bucketLabel(hardware.recommendedBucket)}
        </div>
      </div>
      {hardware.source === "os-fallback" && (
        <div className="ml-auto text-xs text-muted-foreground">
          Install plugin-local-ai for full GPU detection
        </div>
      )}
    </div>
  );
}
