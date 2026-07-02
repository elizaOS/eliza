/**
 * Standalone Bun server for the "PayPerPixel" x402 image-generation app.
 *
 * The end user pays for each image in USDC over the x402 protocol — no Eliza
 * Cloud account, no credit top-up, just a wallet. The settled crypto payment is
 * attributed to this app's creator as redeemable earnings (Eliza Cloud's
 * `recordAppScopedPaymentEarnings` fires on settle when the payment request
 * carries an `appId`). The image itself is generated with the app owner's Cloud
 * credits, funded over time by those same earnings.
 *
 * Routes:
 *   GET  /                  → public/index.html
 *   GET  /style.css, etc.   → public/* static
 *   GET  /api/config        → non-secret app config (app_id, price, network)
 *   POST /api/generate      → x402-gated image generation (see below)
 *   GET  /api/earnings      → this app's earnings summary (the "money out" side)
 *   GET  /health            → "ok" for container health probes
 *
 * The /api/generate flow is the standard x402 "retry with payment" handshake:
 *
 *   1. POST { prompt }                       → 402 + payment requirements
 *      (server creates a durable x402 payment request bound to ELIZA_APP_ID)
 *   2. wallet signs & the browser settles the payment client-side
 *   3. POST { prompt, paymentRequestId, paymentPayload }
 *      → server settles the request (credits the creator's earnings),
 *        generates the image, and returns it.
 */

import {
  CloudApiError,
  ElizaCloudClient,
  type GenerateImageResponse,
  type X402PaymentRequestView,
} from "@elizaos/cloud-sdk";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL("./public/", import.meta.url);

const CLOUD_URL = (
  process.env.ELIZA_CLOUD_URL ?? "https://elizacloud.ai"
).replace(/\/+$/, "");
const API_KEY =
  process.env.ELIZAOS_CLOUD_API_KEY ?? process.env.ELIZA_CLOUD_API_KEY ?? "";
const APP_ID = process.env.ELIZA_APP_ID ?? "";
const NETWORK = process.env.X402_NETWORK ?? "base";
const PRICE_USD = Number(process.env.X402_PRICE_USD ?? "0.05");
const IMAGE_MODEL = process.env.X402_IMAGE_MODEL ?? "";

/**
 * Generation is idempotent per payment: a settled payment request mints exactly
 * one image for this process lifetime, so a retried POST never double-charges
 * the owner's Cloud credits.
 */
const generatedFor = new Set<string>();

function cloudClient(): ElizaCloudClient {
  return new ElizaCloudClient({ baseUrl: CLOUD_URL, apiKey: API_KEY });
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function cloudErrorResponse(err: unknown): Response {
  if (err instanceof CloudApiError) {
    return new Response(
      JSON.stringify(err.errorBody ?? { error: err.message }),
      {
        status: err.statusCode,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  }
  return jsonError(
    502,
    "upstream_unreachable",
    "Eliza Cloud is not responding. Try again shortly.",
  );
}

function firstImage(
  result: GenerateImageResponse,
): { url?: string; image?: string } | null {
  return result.images?.[0] ?? null;
}

/**
 * Step 1: no payment yet. Create a durable x402 payment request bound to this
 * app and hand the browser the x402 challenge so the wallet can pay.
 */
async function quote(prompt: string): Promise<Response> {
  const cloud = cloudClient();
  const created = await cloud.createX402PaymentRequest({
    amountUsd: PRICE_USD,
    network: NETWORK,
    appId: APP_ID,
    description: `Image: ${prompt.slice(0, 80)}`,
    metadata: {
      kind: "payperpixel_image",
      promptPreview: prompt.slice(0, 120),
    },
  });

  return Response.json(
    {
      status: "payment_required",
      paymentRequestId: created.paymentRequest.id,
      amountUsd: created.paymentRequest.amountUsd,
      totalChargedUsd: created.paymentRequest.totalChargedUsd,
      network: created.paymentRequest.network,
      payTo: created.paymentRequest.payTo,
      asset: created.paymentRequest.asset,
      expiresAt: created.paymentRequest.expiresAt,
      paymentRequired: created.paymentRequired,
      paymentRequiredHeader: created.paymentRequiredHeader,
    },
    {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": created.paymentRequiredHeader,
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED",
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Step 3: settle the payment, then generate. Settling credits the creator's
 * redeemable earnings upstream; generation spends the owner's Cloud credits.
 */
async function settleAndGenerate(
  prompt: string,
  paymentRequestId: string,
  paymentPayload: Record<string, unknown>,
): Promise<Response> {
  const cloud = cloudClient();

  let settled: X402PaymentRequestView;
  try {
    const result = await cloud.settleX402PaymentRequest(
      paymentRequestId,
      paymentPayload as Parameters<
        ElizaCloudClient["settleX402PaymentRequest"]
      >[1],
    );
    settled = result.paymentRequest;
  } catch (err) {
    return cloudErrorResponse(err);
  }
  if (!settled.paid) {
    return jsonError(402, "payment_unsettled", "Payment has not settled yet.");
  }

  if (generatedFor.has(paymentRequestId)) {
    return jsonError(
      409,
      "already_generated",
      "An image was already generated for this payment.",
    );
  }

  let result: GenerateImageResponse;
  try {
    result = await cloud.generateImage({
      prompt,
      numImages: 1,
      ...(IMAGE_MODEL ? { model: IMAGE_MODEL } : {}),
    });
  } catch (err) {
    return cloudErrorResponse(err);
  }

  const image = firstImage(result);
  if (!image) {
    return jsonError(502, "no_image", "The model returned no image.");
  }
  generatedFor.add(paymentRequestId);

  return Response.json(
    {
      status: "ok",
      image,
      paymentRequestId,
      transaction: settled.transaction ?? null,
      paidUsd: settled.amountUsd,
      payer: settled.payer ?? null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function handleGenerate(req: Request): Promise<Response> {
  if (!API_KEY || !APP_ID) {
    return jsonError(
      503,
      "not_configured",
      "Set ELIZAOS_CLOUD_API_KEY and ELIZA_APP_ID to enable image generation.",
    );
  }

  let body: {
    prompt?: unknown;
    paymentRequestId?: unknown;
    paymentPayload?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_body", "Request body must be JSON.");
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return jsonError(400, "missing_prompt", "A non-empty prompt is required.");
  }
  if (prompt.length > 1000) {
    return jsonError(
      400,
      "prompt_too_long",
      "Prompt must be 1000 characters or fewer.",
    );
  }

  const paymentRequestId =
    typeof body.paymentRequestId === "string" ? body.paymentRequestId : "";
  const payload = body.paymentPayload;
  const hasPayment =
    paymentRequestId &&
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload);

  return hasPayment
    ? settleAndGenerate(
        prompt,
        paymentRequestId,
        payload as Record<string, unknown>,
      )
    : quote(prompt);
}

async function handleEarnings(): Promise<Response> {
  if (!API_KEY || !APP_ID) {
    return jsonError(
      503,
      "not_configured",
      "Set ELIZAOS_CLOUD_API_KEY and ELIZA_APP_ID.",
    );
  }
  try {
    const earnings = await cloudClient().getAppEarnings(APP_ID);
    return Response.json(earnings, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    return cloudErrorResponse(err);
  }
}

function handleConfig(): Response {
  return Response.json(
    {
      app_id: APP_ID || null,
      cloud_url: CLOUD_URL,
      network: NETWORK,
      price_usd: PRICE_USD,
      currency: "USDC",
      configured: Boolean(API_KEY && APP_ID),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const target = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (target.includes("..")) return null;
  const file = Bun.file(new URL(target, PUBLIC_DIR));
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-store" } });
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/api/config") {
      return handleConfig();
    }
    if (url.pathname === "/api/generate" && req.method === "POST") {
      return handleGenerate(req);
    }
    if (url.pathname === "/api/earnings" && req.method === "GET") {
      return handleEarnings();
    }
    if (url.pathname.startsWith("/api/")) {
      return jsonError(404, "not_found", "unknown route");
    }

    const staticRes = await serveStatic(url.pathname);
    if (staticRes) return staticRes;
    return new Response("not found", { status: 404 });
  },
});

console.log(
  `[payperpixel] listening on http://${server.hostname}:${server.port}`,
);
console.log(`[payperpixel] cloud:   ${CLOUD_URL}`);
console.log(`[payperpixel] app_id:  ${APP_ID || "(unset)"}`);
console.log(
  `[payperpixel] price:   $${PRICE_USD.toFixed(2)} USDC on ${NETWORK}`,
);
