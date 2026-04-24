import { AlertTriangle, Cpu, Gauge, HardDrive } from "lucide-react";
import type { HardwareProbe } from "../../api/client-local-inference";
import { bucketLabel } from "./hub-utils";

interface HardwareBadgeProps {
  hardware: HardwareProbe;
}

export function HardwareBadge({ hardware }: HardwareBadgeProps) {
  const gpuText = hardware.gpu
    ? `${hardware.gpu.backend.toUpperCase()} · ${hardware.gpu.totalVramGb.toFixed(1)} GB VRAM`
    : "CPU only";
  const chipLabel = hardware.appleSilicon ? "Apple Silicon" : hardware.arch;

  return (
    <div className="grid gap-2 rounded-xl border border-border bg-card p-3 text-sm sm:grid-cols-3">
      <div className="flex min-w-0 items-center gap-2">
        <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="truncate font-medium" title="CPU and memory">
          {hardware.totalRamGb.toFixed(0)} GB RAM · {hardware.cpuCores} cores ·{" "}
          {chipLabel}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <HardDrive
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="truncate font-medium" title="GPU">
          {gpuText}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Gauge className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="font-medium" title="Recommended preset">
          Preset: {bucketLabel(hardware.recommendedBucket)}
        </div>
      </div>
      {hardware.source === "os-fallback" && (
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground sm:col-span-3">
          <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />
          <span>Install plugin-local-ai for full GPU detection</span>
        </div>
      )}
    </div>
  );
}
