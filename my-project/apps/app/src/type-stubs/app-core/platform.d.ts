export function applyForceFreshFirstRunReset(): void;
export function applyLaunchConnectionFromUrl(): Promise<boolean>;
export function installDesktopPermissionsClientPatch(client: unknown): void;
export function installForceFreshFirstRunClientPatch(client: unknown): void;
export function installLocalProviderCloudPreferencePatch(client: unknown): void;
export function isDetachedWindowShell(route?: string | null): boolean;
export function resolveWindowShellRoute(): string | null;
export function shouldInstallMainWindowFirstRunPatches(
  route?: string | null,
): boolean;
export function syncDetachedShellLocation(route?: string | null): void;
