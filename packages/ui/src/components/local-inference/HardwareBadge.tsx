import { AlertTriangle, Cpu, Gauge, HardDrive } from "lucide-react";
import type { HardwareProbe } from "../../api/client-local-inference";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { bucketLabel } from "./hub-utils";

interface HardwareBadgeProps {
  hardware: HardwareProbe;
}

export function HardwareBadge({ hardware }: HardwareBadgeProps) {
  const { t } = useTranslation();
  const gpuText = hardware.gpu
    ? `${hardware.gpu.backend.toUpperCase()} · ${hardware.gpu.totalVramGb.toFixed(1)} GB VRAM`
    : t("hardwarebadge.cpuOnly", { defaultValue: "CPU only" });
  const chipLabel = hardware.appleSilicon ? "Apple Silicon" : hardware.arch;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border bg-card/60 px-2 py-1.5 text-xs">
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-sm bg-bg/60 px-2 py-1"
        title={t("hardwarebadge.cpuMemoryTitle", {
          defaultValue: "CPU and memory",
        })}
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">
          {hardware.totalRamGb.toFixed(0)} GB · {hardware.cpuCores}c ·{" "}
          {chipLabel}
        </span>
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-sm bg-bg/60 px-2 py-1"
        title={t("hardwarebadge.gpuTitle", { defaultValue: "GPU" })}
      >
        <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate font-medium">{gpuText}</span>
      </div>
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-sm bg-bg/60 px-2 py-1"
        title={t("hardwarebadge.recommendedPresetTitle", {
          defaultValue: "Recommended preset",
        })}
      >
        <Gauge className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="font-medium">
          {bucketLabel(hardware.recommendedBucket)}
        </span>
      </div>
      {hardware.source === "os-fallback" && (
        <div
          className="inline-flex items-center gap-1.5 rounded-sm bg-warn/10 px-2 py-1 text-warn"
          title={t("hardwarebadge.gpuProbeLimitedTitle", {
            defaultValue: "Install plugin-local-ai for full GPU detection",
          })}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          <span>
            {t("hardwarebadge.gpuProbeLimited", {
              defaultValue: "GPU probe limited",
            })}
          </span>
        </div>
      )}
    </div>
  );
}
