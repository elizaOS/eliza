/**
 * Section header: accent dot + label, optional title and description.
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
        <span className="inline-block w-2 h-2 bg-accent" />
        <p
          className={cn(
            "text-xl uppercase tracking-wider font-normal text-txt leading-[26px]",
            labelClassName,
          )}
        >
          {label}
        </p>
      </div>

      {title && (
        <h2
          className={cn(
            "text-3xl md:text-4xl lg:text-5xl font-bold mb-4 text-txt-strong",
            titleClassName,
          )}
        >
          {title}
        </h2>
      )}

      {description && (
        <div
          className={cn(
            "text-muted-foreground text-base md:text-lg",
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

export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="inline-block w-2 h-2 bg-accent" />
      <span className="text-xl uppercase font-normal text-txt leading-[26px]">
        {children}
      </span>
    </div>
  );
}
