import { cn } from "../../lib/utils";
import { ElizaLogo } from "./eliza-logo";

interface ElizaCloudLockupProps {
  className?: string;
  logoClassName?: string;
  textClassName?: string;
}

export function ElizaCloudLockup({
  className,
  logoClassName,
  textClassName,
}: ElizaCloudLockupProps) {
  return (
    <div aria-label="Eliza Cloud" className={cn("flex items-center gap-2.5", className)}>
      <ElizaLogo className={cn("h-4 shrink-0 text-white md:h-5", logoClassName)} />
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.32em] text-white/55",
          textClassName,
        )}
      >
        Cloud
      </span>
    </div>
  );
}
