import type { CartesiaInkWebSocketFactory } from "@elizaos/host/voice/cartesia-ink";

/** Speech-only sessions favor short conversational turns. Do not change the
 * patient profile used by other hosts. Provider finals remain the authority;
 * eager-end events are forwarded as eager-end events, never promoted to final.
 * https://docs.cartesia.ai/use-the-api/stt/turns
 */
export function speechRelayInkFactory(
  factory: CartesiaInkWebSocketFactory,
  configuredTimeout?: string,
): CartesiaInkWebSocketFactory {
  const requested =
    configuredTimeout === undefined ? 1280 : Number(configuredTimeout);
  if (!Number.isSafeInteger(requested))
    throw Error("Invalid speech endpoint timeout");
  const timeout = Math.max(640, Math.min(5000, requested));
  return (request) => {
    const url = new URL(request.url);
    url.searchParams.set("turn_start_threshold", "0.7");
    url.searchParams.set("turn_eager_end_threshold", "0.6");
    url.searchParams.set("turn_end_threshold", "0.4");
    url.searchParams.set("turn_end_timeout_ms", String(timeout));
    return factory({ ...request, url: url.toString() });
  };
}
