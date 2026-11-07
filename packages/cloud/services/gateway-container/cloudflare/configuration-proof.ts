/** Read-only deployment proof for the protected release workflow. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PROOF_SETTINGS = [
  "GATEWAY_INTERNAL_SECRET",
  "ELIZA_CLOUD_URL",
  "AGENT_ROUTER_ORIGIN_HOST",
  "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
  "ELIZA_APP_TELEGRAM_BOT_ID",
  "ELIZA_APP_TELEGRAM_BOT_USERNAME",
  "ELIZA_APP_TELEGRAM_BOT_TOKEN",
  "ELIZA_APP_TELEGRAM_WEBHOOK_SECRET",
  "ELIZA_APP_BLOOIO_API_KEY",
  "ELIZA_APP_BLOOIO_PHONE_NUMBER",
  "ELIZA_APP_BLOOIO_WEBHOOK_SECRET",
  "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
] as const;

interface ProofEnvironment {
  GATEWAY_RUNTIME_CONFIG?: string;
  GATEWAY_ENABLED: string;
  GATEWAY_KIND: string;
  DEPLOYMENT_ENV: string;
  BUILD_ID: string;
}

export function configurationDigest(
  nonce: string,
  names: string[],
  settings: Record<string, string>,
): string {
  return createHmac("sha256", nonce)
    .update(JSON.stringify(names.map((name) => [name, settings[name] ?? null])))
    .digest("hex");
}

export async function configurationProof(
  request: Request,
  env: ProofEnvironment,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers });
  }
  const settings: unknown = JSON.parse(env.GATEWAY_RUNTIME_CONFIG ?? "null");
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return new Response("Gateway not configured", { status: 503, headers });
  }
  for (const value of Object.values(settings)) {
    if (typeof value !== "string")
      throw new TypeError("Invalid gateway settings");
  }
  const config = settings as Record<string, string>;
  const secret = config.GATEWAY_BOOTSTRAP_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const expected = secret ? `Bearer ${secret}` : "";
  const actualBytes = new TextEncoder().encode(supplied);
  const expectedBytes = new TextEncoder().encode(expected);
  if (
    !secret?.trim() ||
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return new Response("Unauthorized", { status: 401, headers });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new Response("Invalid proof request", { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Invalid proof request", { status: 400, headers });
  }
  const { nonce, names } = body as Record<string, unknown>;
  if (
    typeof nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => !PROOF_SETTINGS.includes(name)) ||
    new Set(names).size !== names.length
  ) {
    return new Response("Invalid proof request", { status: 400, headers });
  }
  return Response.json(
    {
      sourceSha: env.BUILD_ID,
      environment: env.DEPLOYMENT_ENV,
      kind: env.GATEWAY_KIND,
      enabled: env.GATEWAY_ENABLED === "true",
      digest: configurationDigest(nonce, names, config),
    },
    { headers },
  );
}
