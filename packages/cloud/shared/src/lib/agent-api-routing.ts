/** Shares the cloud agent bridge and web path ownership between direct sandbox requests and the public router. */

export function isAgentBridgePath(pathname: string): boolean {
  return (
    pathname === "/bridge" ||
    pathname === "/v1/chat/completions" ||
    pathname.startsWith("/api/agents") ||
    pathname.startsWith("/api/conversations") ||
    pathname.startsWith("/api/messaging") ||
    pathname.startsWith("/api/restore") ||
    pathname.startsWith("/api/snapshot") ||
    pathname.startsWith("/api/wallet")
  );
}
