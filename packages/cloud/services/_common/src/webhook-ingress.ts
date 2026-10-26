/** Existing gateway ingress keyspace and its two atomic hold transactions. */
export const HOLD_INDEX_KEY = "webhook:cutover-holds";
export const HOLD_RECORD_PREFIX = "webhook:cutover-hold:";
export const HOLD_LEASE_PREFIX = "webhook:cutover-hold-lease:";
export function isIngressMarker(key: string): boolean {
  return ["telegram", "blooio", "twilio", "whatsapp"].some(
    (platform) =>
      key.startsWith(`webhook:${platform}:`) &&
      key.length > `webhook:${platform}:`.length,
  );
}
export function isIngressKey(key: string): boolean {
  return (
    isIngressMarker(key) ||
    (key.startsWith(HOLD_RECORD_PREFIX) &&
      isIngressMarker(key.slice(HOLD_RECORD_PREFIX.length))) ||
    (key.startsWith(HOLD_LEASE_PREFIX) &&
      isIngressMarker(key.slice(HOLD_LEASE_PREFIX.length)))
  );
}
export const HOLD_SAVE_SCRIPT = `if ARGV[5] ~= '' and redis.call('GET', KEYS[4]) ~= ARGV[5] then return 0 end
     redis.call('SET', KEYS[1], ARGV[1])
     redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
     redis.call('SET', KEYS[3], ARGV[4])
     return 1`;
export const HOLD_REMOVE_SCRIPT = `local owner = redis.call('GET', KEYS[1])
       if owner and owner ~= ARGV[1] then return 0 end
       if ARGV[3] ~= '' and redis.call('GET', KEYS[4]) == ARGV[3] then return 0 end
       redis.call('DEL', KEYS[2])
       redis.call('ZREM', KEYS[3], ARGV[2])
       return 1`;
export class WebhookIngressStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookIngressStateError";
  }
}
export function cloudflareIngressTransport(
  env: Record<string, string | undefined>,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  let url: URL;
  try {
    url = new URL(env.WEBHOOK_INGRESS_URL ?? "");
  } catch {
    throw new WebhookIngressStateError("WEBHOOK_INGRESS_URL is required");
  }
  const token = env.WEBHOOK_INGRESS_TOKEN;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/internal/webhook-ingress" ||
    !token?.trim()
  )
    throw new WebhookIngressStateError("Invalid webhook ingress authority");
  return async (operation: string, fields: object): Promise<unknown> => {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, ...fields }),
    });
    if (!response.ok)
      throw new WebhookIngressStateError(
        `Webhook ingress state failed (${response.status})`,
      );
    return response.json();
  };
}
