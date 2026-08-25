/** Defines the persistent connection contract for reusable Cloudflare Browser Run tabs. */

export interface PersistentBrowserConnectOptions {
  readonly sessionId: string;
  readonly persistent: true;
}

export function doorDashPersistentConnectOptions(
  sessionId: string,
): PersistentBrowserConnectOptions {
  return { sessionId, persistent: true };
}

export function isDoorDashBrowserRunProviderBlock(title: string, body: string): boolean {
  const visibleText = `${title}\n${body}`.toLowerCase();
  return visibleText.includes("incompatible browser extension or network configuration");
}
