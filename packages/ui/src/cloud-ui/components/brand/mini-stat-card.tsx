import { cn } from "../../lib/utils";

interface MiniStatCardProps {
  label: string;
  value: string;
  color?: string;
  className?: string;
}

export function MiniStatCard({
  label,
  value,
  color = "text-txt-strong",
  className,
}: MiniStatCardProps) {
  return (
    <div className={cn("rounded-sm border border-border bg-bg-elevated p-3", className)}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold mt-0.5", color)}>{value}</p>
    </div>
  );
}
