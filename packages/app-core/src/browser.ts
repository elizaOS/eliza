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

// MILADY local-mode renderer reach-through: pull in the full app-core
// dist surface so milady's `main.tsx` can resolve symbols like
// `DesktopOnboardingRuntime`, `AppProvider`, `client`, etc. that the
// minimal browser entry omits. Server-only re-exports inside dist
// (account-pool, onboarding-routes, etc.) are kept renderer-safe by
// stubbing `@elizaos/agent` and `@elizaos/plugin-elizacloud` to
// browser stubs (see apps/app/vite.config.ts native-module-stub plugin).
export * from "../dist/index.js";

// MILADY local-mode stubs for symbols removed during the P1A refactor.
// The mobile/web renderer doesn't actually mount these (the desktop
// shell is opt-in via the runtime mode), so noop React components are
// safe. Restore real implementations if/when upstream restores them
// or move milady's main.tsx off these imports entirely.
export const DESKTOP_TRAY_MENU_ITEMS: ReadonlyArray<{
  id: string;
  label: string;
}> = [];
export const DesktopOnboardingRuntime = (): null => null;
export const DesktopSurfaceNavigationRuntime = (): null => null;
export const DesktopTrayRuntime = (): null => null;
export const DetachedShellRoot = (): null => null;
