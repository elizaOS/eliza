export async function handleSandboxRoute(): Promise<boolean> {
  return false;
}

export function getDiscordAvatarCacheDir(): string {
  return "/tmp/elizaos-ui-test-discord-avatars";
}

export function getDiscordAvatarCachePath(fileName: string): string {
  return `${getDiscordAvatarCacheDir()}/${fileName}`;
}

export const BROWSER_BRIDGE_KINDS = ["chrome-extension"] as const;

export const BROWSER_BRIDGE_PACKAGE_PATH_TARGETS = [
  "chrome-extension",
] as const;

export function buildBrowserBridgeCompanionPackage(): never {
  throw new Error("browser companion packaging is not available in UI tests");
}

export function closeBrowserWorkspaceTab(): boolean {
  return false;
}

export function evaluateBrowserWorkspaceTab(): undefined {
  return undefined;
}

export function executeBrowserWorkspaceCommand(): undefined {
  return undefined;
}

export function getBrowserBridgeCompanionPackageStatus(): undefined {
  return undefined;
}

export function getBrowserWorkspaceSnapshot(): undefined {
  return undefined;
}

export function hideBrowserWorkspaceTab(): boolean {
  return false;
}

export function listBrowserWorkspaceTabs(): unknown[] {
  return [];
}

export function navigateBrowserWorkspaceTab(): boolean {
  return false;
}

export function openBrowserBridgeCompanionManager(): boolean {
  return false;
}

export function openBrowserBridgeCompanionPackagePath(): boolean {
  return false;
}

export function openBrowserWorkspaceTab(): { kind: string } {
  return { kind: "chrome-extension" };
}

export function showBrowserWorkspaceTab(): boolean {
  return false;
}

export function snapshotBrowserWorkspaceTab(): undefined {
  return undefined;
}

export function applySignalQrOverride(): void {}

export function applyWhatsAppQrOverride(): void {}

export function handleWhatsAppRoute(): boolean {
  return false;
}

export function handleTriggerRoutes(): boolean {
  return false;
}

export function handleAppsRoutes(): boolean {
  return false;
}

export function handleWalletRoutes(): boolean {
  return false;
}

export function createPaymentAwareHandler(route: {
  handler?: (...args: unknown[]) => unknown;
}): (...args: unknown[]) => unknown {
  return route.handler ?? (() => false);
}

export function isRoutePaymentWrapped(): boolean {
  return false;
}

export function validateX402Startup(): void {}

export const plugin = {};

export default plugin;
