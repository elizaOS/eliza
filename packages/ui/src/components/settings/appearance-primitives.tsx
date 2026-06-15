import type { ReactNode } from "react";

export function ModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-sm border text-sm font-medium transition-colors ${
        active
          ? "border-accent bg-accent/8 text-txt"
          : "border-border/50 text-muted hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
      }`}
    >
      {icon}
    </button>
  );
}
