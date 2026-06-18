// Browser-pure stand-in for ../first-run in the onboarding bundle. The real
// module imports @elizaos/shared (Node fs-extra), which esbuild can't bundle for
// the browser. FirstRunShell only uses normalizeFirstRunName at runtime — the
// rest of its imports from here are type-only and erased at build.
export function normalizeFirstRunName(value: string): string {
  return (value ?? "").trim();
}
