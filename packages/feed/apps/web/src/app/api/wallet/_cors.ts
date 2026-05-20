/**
 * Shared CORS configuration for /api/wallet/* routes.
 *
 * All wallet API routes expose the same preflight policy. Define once here
 * so the headers stay in sync — a mismatch between routes would silently
 * break cross-origin reads for some endpoints but not others.
 */
export const WALLET_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function walletOptionsResponse() {
  return new Response(null, { status: 204, headers: WALLET_CORS_HEADERS });
}
