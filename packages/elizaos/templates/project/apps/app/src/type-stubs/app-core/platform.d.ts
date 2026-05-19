export function applyForceFreshOnboardingReset(): void;
export function applyLaunchConnectionFromUrl(): Promise<boolean>;
export function installDesktopPermissionsClientPatch(client: unknown): void;
export function installForceFreshOnboardingClientPatch(client: unknown): void;
export function installLocalProviderCloudPreferencePatch(client: unknown): void;
export function isDetachedWindowShell(route?: string | null): boolean;
export function resolveWindowShellRoute(): string | null;
export function shouldInstallMainWindowOnboardingPatches(
  route?: string | null,
): boolean;
export function syncDetachedShellLocation(route?: string | null): void;
