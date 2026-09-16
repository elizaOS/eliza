/** Bounds recovery GETs through complete response consumption; abort owns headers and body, and no partially read JSON reaches Stripe. */
import { ElizaError } from "@elizaos/core";

export function createStripeRecoveryFetch(deadline: number) {
  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() !== "GET")
        throw new ElizaError("Subscription recovery permits provider reads only", {
          code: "SUBSCRIPTION_RECOVERY_READ_ONLY",
        });
      const remaining = Math.min(10_000, deadline - Date.now());
      if (!Number.isFinite(remaining) || remaining <= 0)
        throw new ElizaError("Subscription recovery read deadline expired", {
          code: "SUBSCRIPTION_RECOVERY_READ_TIMEOUT",
        });
      const controller = new AbortController();
      const upstream = init?.signal ?? (input instanceof Request ? input.signal : null);
      const signal = upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal;
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetch(input, { ...init, signal });
        const bytes = await response.arrayBuffer();
        return new Response(
          response.status === 204 || response.status === 205 || response.status === 304
            ? null
            : bytes,
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      } catch (cause) {
        // error-policy:J2 Preserve transport failure and distinguish the owned deadline from caller cancellation.
        throw new ElizaError(
          controller.signal.aborted
            ? "Subscription recovery read timed out"
            : "Subscription recovery read failed",
          {
            code: controller.signal.aborted
              ? "SUBSCRIPTION_RECOVERY_READ_TIMEOUT"
              : "SUBSCRIPTION_RECOVERY_READ_FAILED",
            cause,
          },
        );
      } finally {
        clearTimeout(timer);
      }
    },
    fetch,
  );
}
