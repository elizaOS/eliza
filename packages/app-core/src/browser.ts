export * from "@elizaos/ui";

export type CompatRuntimeState = {
  current: unknown;
  pendingAgentName?: string | null;
  pendingRestartReasons?: string[];
};

export function sendJson(
  _res: unknown,
  _status: number,
  _body: unknown,
): void {}

export function sendJsonError(
  _res: unknown,
  _status: number,
  _message: string,
): void {}

export async function ensureRouteAuthorized(): Promise<boolean> {
  return false;
}

export async function ensureCompatApiAuthorized(): Promise<boolean> {
  return false;
}

export async function readCompatJsonBody(): Promise<unknown> {
  return null;
}

export function sharedVault(): never {
  throw new Error("sharedVault is server-only");
}

// Reach-through to the full app-core surface so eliza's `main.tsx` can
// resolve symbols like `DesktopOnboardingRuntime`, `AppProvider`,
// `client`, etc. that the minimal browser entry omits. We import from
// `./index.ts` (the source barrel) — tsconfig.build.json has
// `rewriteRelativeImportExtensions: true`, so this becomes `./index.js`
// in the published dist. Same file at runtime; no pre-built `dist/`
// required for local-source consumers (vite in milady's source mode).
// Server-only re-exports inside the barrel (account-pool,
// onboarding-routes, etc.) are kept renderer-safe by stubbing
// `@elizaos/agent` and `@elizaos/plugin-elizacloud` to browser stubs
// (see apps/app/vite.config.ts native-module-stub plugin).
export * from "./index.ts";

// `ConfigField` and `getPlugins` exist in both `@elizaos/ui` (UI component +
// runtime helper) and the app-core registry barrel. Pin the registry side
// explicitly so eliza's main.tsx gets the registry `ConfigField` type it
// expects; UI consumers can still import the component directly from
// `@elizaos/ui`.
export { type ConfigField, getPlugins } from "./index.ts";

// ELIZA local-mode stubs for symbols removed during the P1A refactor.
// The mobile/web renderer doesn't actually mount these (the desktop
// shell is opt-in via the runtime mode), so noop React components are
// safe. Restore real implementations if/when upstream restores them
// or move eliza's main.tsx off these imports entirely.
export const DESKTOP_TRAY_MENU_ITEMS: ReadonlyArray<{
  id: string;
  label: string;
}> = [];
export const DesktopOnboardingRuntime = (): null => null;
export const DesktopSurfaceNavigationRuntime = (): null => null;
export const DesktopTrayRuntime = (): null => null;
export const DetachedShellRoot = (): null => null;
