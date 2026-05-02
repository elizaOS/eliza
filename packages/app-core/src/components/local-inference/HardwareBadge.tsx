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
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1.5 text-xs">
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1"
        title="CPU and memory"
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">
          {hardware.totalRamGb.toFixed(0)} GB · {hardware.cpuCores}c ·{" "}
          {chipLabel}
        </span>
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1"
        title="GPU"
      >
        <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">{gpuText}</span>
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-bg/60 px-2 py-1"
        title="Recommended preset"
      >
        <Gauge className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="font-medium">
          {bucketLabel(hardware.recommendedBucket)}
        </span>
      </div>
      {hardware.source === "os-fallback" && (
        <div
          className="inline-flex items-center gap-1.5 rounded-md bg-warn/10 px-2 py-1 text-warn"
          title="Install plugin-local-ai for full GPU detection"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          <span>GPU probe limited</span>
        </div>
      )}
    </div>
  );
}
