import { cn } from "../../lib/utils";

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
    <div
      aria-label="eliza cloud"
      role="img"
      className={cn("flex items-center", className)}
    >
      <span
        className={cn(
          "font-[family-name:var(--font-display)] text-2xl font-normal leading-none tracking-normal text-white",
          logoClassName,
          textClassName,
        )}
      >
        eliza<strong className="font-bold">cloud</strong>
      </span>
    </div>
  );
}
