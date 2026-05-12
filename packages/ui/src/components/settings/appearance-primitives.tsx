import type { ReactNode } from "react";

export function selectableTileClass(active: boolean): string {
  return `relative flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-lg border p-3 transition-colors ${
    active
      ? "border-accent bg-accent/8"
      : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
  }`;
}

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
      className={`flex h-10 w-10 items-center justify-center rounded-lg border text-sm font-medium transition-colors ${
        active
          ? "border-accent bg-accent/8 text-txt"
          : "border-border/50 text-muted hover:border-accent/40 hover:bg-bg-hover hover:text-txt"
      }`}
    >
      {icon}
    </button>
  );
}
