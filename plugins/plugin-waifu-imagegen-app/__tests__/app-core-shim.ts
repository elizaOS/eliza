// Test shim for `@elizaos/app-core`. The real package pulls in the API server
// graph; tests only need the overlay-app registration entry, the overlay
// context type, and the few UI primitives ImageGenAppView reads. Render tests
// `vi.mock("@elizaos/app-core", ...)` inline with their own React stubs; this
// shim only covers the paths that are NOT mocked (e.g. the overlay-app
// side-effect import).

export interface OverlayApp {
  name: string;
  component?: unknown;
  [key: string]: unknown;
}

export interface OverlayAppContext {
  exitToApps: () => void;
  uiTheme?: string;
  t?: (key: string) => string;
  [key: string]: unknown;
}

export const client = {};

export function registerOverlayApp(_app: OverlayApp): void {}

export const Button = (_props: unknown): null => null;

export const Spinner = (_props: unknown): null => null;

export const PagePanel = {
  Notice: (_props: unknown): null => null,
};
