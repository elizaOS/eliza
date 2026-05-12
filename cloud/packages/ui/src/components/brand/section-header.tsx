/**
 * Section header component with orange dot indicator and optional title/description.
 * Supports left, center, and right alignment with customizable styling.
 *
 * @param props - Section header configuration
 * @param props.label - Label text displayed with dot indicator
 * @param props.title - Optional title text
 * @param props.description - Optional description text
 * @param props.align - Text alignment (left, center, right)
 */
import { cn } from "../../lib/utils";

interface SectionHeaderProps {
  label: string;
  title?: string | React.ReactNode;
  description?: string | React.ReactNode;
  className?: string;
  labelClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  align?: "left" | "center" | "right";
}

export function SectionHeader({
  label,
  title,
  description,
  className,
  labelClassName,
  titleClassName,
  descriptionClassName,
  align = "left",
}: SectionHeaderProps) {
  const alignClass = {
    left: "text-left",
    center: "text-center items-center justify-center",
    right: "text-right items-end justify-end",
  }[align];

  return (
    <div className={cn("mb-12", alignClass, className)}>
      <div
        className={cn(
          "flex items-center gap-3 mb-4",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
        )}
      >
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: "#FF5800" }}
        />
        <p
          className={cn("text-xl uppercase tracking-wider font-normal", labelClassName)}
          style={{
            color: "#E1E1E1",
            lineHeight: "26px",
          }}
        >
          {label}
        </p>
      </div>

      {title && (
        <h2
          className={cn(
            "text-3xl md:text-4xl lg:text-5xl font-bold mb-4 text-white",
            titleClassName,
          )}
        >
          {title}
        </h2>
      )}

      {description && (
        <div
          className={cn(
            "text-white/70 text-base md:text-lg",
            align === "center" && "max-w-2xl mx-auto",
            descriptionClassName,
          )}
        >
          {description}
        </div>
      )}
    </div>
  );
}

// Simple variant with just label and dot
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="inline-block w-2 h-2" style={{ backgroundColor: "#FF5800" }} />
      <span
        className="text-xl uppercase font-normal"
        style={{
          color: "#E1E1E1",
          lineHeight: "26px",
        }}
      >
        {children}
      </span>
    </div>
  );
}
