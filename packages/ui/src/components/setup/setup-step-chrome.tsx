export function SetupStepDivider() {
  return (
    <div className="my-4 flex items-center gap-3 before:h-px before:flex-1 before: before:from-transparent before:via-[var(--first-run-divider)] before:to-transparent after:h-px after:flex-1 after: after:from-transparent after:via-[var(--first-run-divider)] after:to-transparent">
      <div className="h-1.5 w-1.5 shrink-0 rotate-45 bg-[rgba(240,185,11,0.4)]" />
    </div>
  );
}
