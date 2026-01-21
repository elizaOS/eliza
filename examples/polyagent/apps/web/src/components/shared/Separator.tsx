import { cn } from "@polyagent/shared";

/**
 * Separator component for visual division between content sections.
 *
 * Provides a styled separator line with gradient effect. Supports both
 * horizontal and vertical orientations. Uses a subtle blue gradient with
 * shadow for visual depth.
 *
 * @param props - Separator component props
 * @returns Separator element
 *
 * @example
 * ```tsx
 * <Separator orientation="horizontal" />
 * <Separator orientation="vertical" className="h-20" />
 * ```
 */
interface SeparatorProps {
  className?: string;
  orientation?: "horizontal" | "vertical";
}

export function Separator({
  className,
  orientation = "horizontal",
}: SeparatorProps) {
  if (orientation === "vertical") {
    return (
      <div className={cn("h-full w-px", className)}>
        <div
          className="h-full w-px rounded-full"
          style={{
            background:
              "linear-gradient(180deg, transparent, rgba(28, 156, 240, 0.3), transparent)",
            boxShadow: "1px 0 2px rgba(0, 0, 0, 0.1)",
          }}
        />
      </div>
    );
  }

  return (
    <div className={cn("h-px w-full", className)}>
      <div
        className="h-px w-full rounded-full"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(28, 156, 240, 0.3), transparent)",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
        }}
      />
    </div>
  );
}
