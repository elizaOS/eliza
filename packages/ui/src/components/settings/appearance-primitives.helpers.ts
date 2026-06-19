export function selectableTileClass(active: boolean): string {
  return `relative flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-sm border p-3 transition-colors ${
    active
      ? "border-accent bg-accent/8"
      : "border-border/50 hover:border-accent/40 hover:bg-bg-hover"
  }`;
}
