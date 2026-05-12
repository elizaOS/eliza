import { cn } from "../../lib/utils";

interface MiniStatCardProps {
  label: string;
  value: string;
  color?: string;
  className?: string;
}

export function MiniStatCard({ label, value, color = "text-white", className }: MiniStatCardProps) {
  return (
    <div className={cn("bg-neutral-900 rounded-xl p-3", className)}>
      <p className="text-[10px] text-neutral-500">{label}</p>
      <p className={cn("text-lg font-semibold mt-0.5", color)}>{value}</p>
    </div>
  );
}
