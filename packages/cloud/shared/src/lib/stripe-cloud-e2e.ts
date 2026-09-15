/** Validates the single canonical local Stripe harness endpoint and synthetic credential; production and arbitrary endpoint overrides are rejected. */
const CLOUD_E2E_STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
export interface CloudE2EStripeEndpoint {
  host: string;
  port: string;
  protocol: "http";
}

/**
 * Resolve the Stripe-compatible loopback endpoint used by the full cloud E2E
 * harness. This is deliberately not a generic Stripe base-URL override: an
 * override is accepted only for the exact synthetic test key and only inside
 * the explicit local E2E runtime.
 */
export function resolveCloudE2EStripeEndpoint(
  env: Record<string, string | undefined>,
  secretKey: string,
): CloudE2EStripeEndpoint | null {
  const rawOrigin = env.STRIPE_CLOUD_E2E_API_ORIGIN?.trim();
  if (!rawOrigin) {
    if (secretKey === CLOUD_E2E_STRIPE_SECRET_KEY) {
      throw new Error(
        "SECURITY: the synthetic Stripe Cloud E2E key requires its canonical loopback endpoint",
      );
    }
    return null;
  }

  if (
    env.CLOUD_E2E !== "1" ||
    env.NODE_ENV !== "test" ||
    env.ENVIRONMENT !== "local" ||
    secretKey !== CLOUD_E2E_STRIPE_SECRET_KEY
  ) {
    throw new Error(
      "SECURITY: the Stripe Cloud E2E endpoint is allowed only in the explicit local CLOUD_E2E test runtime with its synthetic test key",
    );
  }

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    // error-policy:J3 Invalid URLs are rejected rather than normalized into a trusted endpoint.
    throw new Error("SECURITY: the Stripe Cloud E2E endpoint must be a valid loopback origin");
  }
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error(
      "SECURITY: the Stripe Cloud E2E endpoint must be an http://127.0.0.1:<port> origin without credentials, path, query, or fragment",
    );
  }
  const port = Number(origin.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SECURITY: the Stripe Cloud E2E endpoint must use an explicit valid port");
  }

  return { host: origin.hostname, port: origin.port, protocol: "http" };
}

export function canonicalStripeCloudE2ECredential(
  env: Record<string, string | undefined>,
): string | null {
  const secret = env.STRIPE_SECRET_KEY?.trim();
  if (secret !== CLOUD_E2E_STRIPE_SECRET_KEY) return null;
  return resolveCloudE2EStripeEndpoint(env, secret) ? secret : null;
}
