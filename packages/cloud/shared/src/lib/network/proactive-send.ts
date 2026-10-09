/** Gateway transport used only for handled replies to recipients without a Cloud account. */

/** Account-bound delivery is unimplemented; this transport grants no history authority. */
export function networkReplyDelivery(options: {
  gatewayBaseUrl: string;
  gatewayInternalSecret: string;
}) {
  const baseUrl = options.gatewayBaseUrl.replace(/\/+$/, "");
  return {
    deliver: async (body: Record<string, unknown>) =>
      await fetch(`${baseUrl}/internal/deliver`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": options.gatewayInternalSecret,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }),
  };
}
