// Test shim for `@elizaos/app-core`. The swap view + overlay registration
// import from this package; vitest aliases it here so tests resolve without a
// built app-core dist. Individual test files that need behavior (e.g. the
// SwapAppView render test) `vi.mock("@elizaos/app-core", …)` with their own
// stubs; this shim only provides inert defaults for modules that import it for
// its side-effecting overlay registry (swap-app.ts).

export interface OverlayApp {
  name: string;
  component?: unknown;
  [key: string]: unknown;
}

export interface OverlayAppContext {
  exitToApps: () => void;
  uiTheme?: "light" | "dark";
  t?: (key: string) => string;
}

export const client = {};

export function registerOverlayApp(_app: OverlayApp): void {}
