/**
 * Harness preload for the webhook gateway process (simulation only; no
 * source changes). The gateway's Blooio adapter hardcodes
 * https://api.blooio.com, so this patches global fetch to redirect every call
 * to that host to the local mock provider (mock-blooio-provider.ts), which
 * records the outbound payload and returns a receipt. Nothing else is
 * touched: cloud-API calls, auth and redis go where they always go.
 *
 * Use:
 *   bun --preload packages/cloud/scripts/group-room-sim/gateway-fetch-tap.preload.ts \
 *     packages/cloud/services/gateway-webhook/src/index.ts
 *
 * Env:
 *   ROOM_SIM_BLOOIO_MOCK_URL  where api.blooio.com traffic goes
 *                             (default http://127.0.0.1:48810)
 */

const BLOOIO_ORIGIN = "https://api.blooio.com";
const mockOrigin = (
  process.env.ROOM_SIM_BLOOIO_MOCK_URL ?? "http://127.0.0.1:48810"
).replace(/\/+$/, "");
const realFetch = globalThis.fetch;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const url = requestUrl(input);
  if (!url.startsWith(BLOOIO_ORIGIN)) return realFetch(input as never, init);
  const redirected = mockOrigin + url.slice(BLOOIO_ORIGIN.length);
  if (typeof input === "string" || input instanceof URL) {
    return realFetch(redirected, init);
  }
  return realFetch(new Request(redirected, input), init);
}) as typeof fetch;

console.log(`[gateway-fetch-tap] ${BLOOIO_ORIGIN} -> ${mockOrigin}`);
