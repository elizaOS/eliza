/**
 * HUD container component with HUD-style corner decorations and hover effects.
 * Used for input areas and cards with animated corner brackets.
 *
 * @param props - HUD container configuration
 * @param props.children - Content to display
 * @param props.cornerSize - Size of corner brackets
 * @param props.cornerColor - Color of corner brackets
 * @param props.withBorder - Whether to display border
 */
import { cn } from "../../lib/utils";
import { CornerBrackets } from "./corner-brackets";

interface HUDContainerProps {
  children: React.ReactNode;
  className?: string;
  cornerSize?: "sm" | "md" | "lg" | "xl";
  cornerColor?: string;
  withBorder?: boolean;
}

export function HUDContainer({
  children,
  className,
  cornerSize = "md",
  cornerColor = "#E1E1E1",
  withBorder = true,
}: HUDContainerProps) {
  return (
    <div
      className={cn(
        "group relative bg-black/40 transition-all duration-300 ease-out",
        withBorder && "border border-white/20 hover:border-white/30",
        className,
      )}
    >
      <CornerBrackets
        size={cornerSize}
        color={cornerColor}
        hoverColor="#FF5800"
        hoverScale={true}
      />
      {children}
    </div>
  );
}
