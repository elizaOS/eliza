/**
 * Decides whether Cloud account authentication may replace the app's primary
 * startup surface. Browser-hosted standalone and dedicated agents retain their
 * own pairing gate even when the production renderer uses cloud-only branding.
 */

export interface CloudAuthFirstScreenHost {
  cloudOnlyBranding: boolean;
  isAgentlessCloudOrigin: boolean;
  isNative: boolean;
  isDesktopShell: boolean;
}

/**
 * Cloud-only branding identifies product capabilities, not necessarily the
 * authority serving the page. Only the Cloud control plane owns browser login;
 * native and desktop cloud-only clients may also initiate that login directly.
 */
export function cloudAuthFirstScreenOwnsHost(
  host: CloudAuthFirstScreenHost,
): boolean {
  if (!host.cloudOnlyBranding) return false;
  return host.isAgentlessCloudOrigin || host.isNative || host.isDesktopShell;
}
