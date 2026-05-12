/**
 * Corner brackets component providing decorative corner elements.
 * Supports multiple sizes, colors, variants (corners or full border), and hover effects.
 *
 * @param props - Corner brackets configuration
 * @param props.size - Size variant (sm, md, lg, xl)
 * @param props.color - Border color
 * @param props.variant - Display variant (corners or full-border)
 * @param props.hoverColor - Optional hover color
 * @param props.hoverScale - Whether to scale on hover
 */
import { cn } from "../../lib/utils";

interface CornerBracketsProps {
  className?: string;
  size?: "sm" | "md" | "lg" | "xl";
  color?: string;
  variant?: "corners" | "full-border";
  hoverColor?: string;
  hoverScale?: boolean;
}

const sizeMap = {
  sm: "w-3 h-3",
  md: "w-4 h-4",
  lg: "w-8 h-8",
  xl: "w-12 h-12",
};

export function CornerBrackets({
  className,
  size = "md",
  color = "#E1E1E1",
  variant = "corners",
  hoverColor,
  hoverScale = false,
}: CornerBracketsProps) {
  const sizeClass = sizeMap[size];
  const borderStyle = { borderColor: color };

  // Add hover class if hoverColor is provided
  const hoverClass = hoverColor ? "corner-bracket-hover" : "";

  if (variant === "full-border") {
    return (
      <div className={cn("pointer-events-none absolute inset-0", className)}>
        {/* Top-left corner */}
        <div
          className={cn(
            "absolute left-0 top-0 border-l-2 border-t-2",
            sizeClass,
            hoverClass,
            hoverScale && "corner-bracket-tl",
          )}
          style={borderStyle}
        />
        {/* Top-right corner */}
        <div
          className={cn(
            "absolute right-0 top-0 border-r-2 border-t-2",
            sizeClass,
            hoverClass,
            hoverScale && "corner-bracket-tr",
          )}
          style={borderStyle}
        />
        {/* Bottom-left corner */}
        <div
          className={cn(
            "absolute bottom-0 left-0 border-b-2 border-l-2",
            sizeClass,
            hoverClass,
            hoverScale && "corner-bracket-bl",
          )}
          style={borderStyle}
        />
        {/* Bottom-right corner */}
        <div
          className={cn(
            "absolute bottom-0 right-0 border-b-2 border-r-2",
            sizeClass,
            hoverClass,
            hoverScale && "corner-bracket-br",
          )}
          style={borderStyle}
        />
      </div>
    );
  }

  return (
    <>
      {/* Top-left corner */}
      <div
        className={cn(
          "absolute top-0 left-0 border-t border-l",
          sizeClass,
          hoverClass,
          hoverScale && "corner-bracket-tl",
          className,
        )}
        style={borderStyle}
      />
      {/* Top-right corner */}
      <div
        className={cn(
          "absolute top-0 right-0 border-t border-r",
          sizeClass,
          hoverClass,
          hoverScale && "corner-bracket-tr",
          className,
        )}
        style={borderStyle}
      />
      {/* Bottom-left corner */}
      <div
        className={cn(
          "absolute bottom-0 left-0 border-b border-l",
          sizeClass,
          hoverClass,
          hoverScale && "corner-bracket-bl",
          className,
        )}
        style={borderStyle}
      />
      {/* Bottom-right corner */}
      <div
        className={cn(
          "absolute bottom-0 right-0 border-b border-r",
          sizeClass,
          hoverClass,
          hoverScale && "corner-bracket-br",
          className,
        )}
        style={borderStyle}
      />
    </>
  );
}
