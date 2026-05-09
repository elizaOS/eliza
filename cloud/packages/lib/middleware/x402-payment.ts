/**
 * x402 Payment Middleware
 *
 * Middleware wrapper for protecting API routes with x402 payments.
 * Follows the same pattern as withRateLimit() — wraps a handler function
 * and intercepts requests to enforce payment requirements.
 *
 * Usage:
 *   // In a route.ts file:
 *   export const POST = withX402Payment(myHandler, {
 *     price: "1000000",   // $1.00 in USDC base units
 *     network: "eip155:8453",
 *     payTo: "0x...",
 *     description: "Premium AI service",
 *   });
 *
 * Flow:
 *   1. Check for X-PAYMENT header
 *   2. If missing → return 402 with payment requirements
 *   3. If present → verify with facilitator service
 *   4. If valid → call handler, return response with payment receipt
 *   5. If invalid → return 402 with error
 */

import { type VerifyResult, x402FacilitatorService } from "@/lib/services/x402-facilitator";
import { logger } from "@/lib/utils/logger";

// Types

/** Configuration for an x402-protected route */
export interface X402PaymentConfig {
  /** Price in USDC base units (6 decimals). "1000000" = $1.00 */
  price: string;
  /** CAIP-2 network identifier. Default: "eip155:8453" (Base) */
  network?: string;
  /** Address to receive payments */
  payTo: string;
  /** Human-readable description of the paid resource */
  description?: string;
  /** MIME type of the response. Default: "application/json" */
  mimeType?: string;
  /** Max timeout in seconds. Default: 300 */
  maxTimeoutSeconds?: number;
  /** Whether to auto-settle (execute on-chain). Default: true */
  autoSettle?: boolean;
}

/** Payment context injected into the request for downstream handlers */
export interface X402PaymentContext {
  payer: string;
  amount: string;
  network: string;
  verified: boolean;
}

// Header name for passing payment context to the handler
const X402_CONTEXT_HEADER = "x-x402-context";

// Middleware

/**
 * Wrap a Next.js API route handler with x402 payment enforcement.
 *
 * Compatible with Next.js 15 App Router where params is a Promise.
 * Follows the same signature as withRateLimit().
 */
export function withX402Payment<T = Record<string, string>>(
  handler: (request: Request, context?: { params: Promise<T> }) => Promise<Response>,
  config: X402PaymentConfig,
) {
  type FacilitatorPaymentPayload = Parameters<typeof x402FacilitatorService.verify>[0];

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  const isFacilitatorPaymentPayload = (
    value: Record<string, unknown>,
  ): value is FacilitatorPaymentPayload => {
    if (typeof value.x402Version !== "number" || !isRecord(value.accepted)) return false;
    if (!isRecord(value.payload) || typeof value.payload.signature !== "string") return false;
    const authorization = value.payload.authorization;
    return (
      isRecord(authorization) &&
      typeof authorization.from === "string" &&
      typeof authorization.to === "string" &&
      typeof authorization.value === "string" &&
      typeof authorization.validAfter === "string" &&
      typeof authorization.validBefore === "string" &&
      typeof authorization.nonce === "string"
    );
  };

  const network = config.network ?? "eip155:8453";
  const description = config.description ?? "Paid API endpoint";
  const mimeType = config.mimeType ?? "application/json";
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 300;
  const autoSettle = config.autoSettle !== false;

  return async (request: Request, routeContext?: { params: Promise<T> }): Promise<Response> => {
    // 1. Check for X-PAYMENT header
    const paymentHeader =
      request.headers.get("x-payment") ??
      request.headers.get("X-PAYMENT") ??
      request.headers.get("payment-signature");

    if (!paymentHeader) {
      // Return 402 Payment Required with payment requirements
      return buildPaymentRequiredResponse(
        config.price,
        network,
        config.payTo,
        description,
        mimeType,
        maxTimeoutSeconds,
        request.url,
      );
    }

    // 2. Decode the payment payload
    let paymentPayload: Record<string, unknown>;
    try {
      const decoded = Buffer.from(paymentHeader, "base64").toString("utf-8");
      paymentPayload = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      try {
        paymentPayload = JSON.parse(paymentHeader) as Record<string, unknown>;
      } catch {
        return Response.json(
          {
            success: false,
            error: "Invalid X-PAYMENT header: not valid base64/JSON",
            code: "INVALID_PAYMENT_HEADER",
          },
          { status: 400 },
        );
      }
    }

    // 3. Build payment requirements
    if (!isFacilitatorPaymentPayload(paymentPayload)) {
      return Response.json(
        {
          success: false,
          error: "Invalid X-PAYMENT header: missing required payment fields",
          code: "INVALID_PAYMENT_HEADER",
        },
        { status: 400 },
      );
    }
    const parsedPaymentPayload = paymentPayload;
    const paymentRequirements = {
      scheme: "upto",
      network,
      asset: getUsdcAddress(network),
      amount: config.price,
      payTo: config.payTo,
      maxTimeoutSeconds,
    };

    // 4. Verify with facilitator service
    let verifyResult: VerifyResult;
    try {
      verifyResult = await x402FacilitatorService.verify(parsedPaymentPayload, paymentRequirements);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[x402-middleware] Verification failed: ${msg}`);
      return Response.json(
        {
          success: false,
          error: "Payment verification failed",
          code: "VERIFICATION_ERROR",
        },
        { status: 500 },
      );
    }

    if (!verifyResult.isValid) {
      logger.warn(`[x402-middleware] Payment invalid: ${verifyResult.invalidReason}`);
      return Response.json(
        {
          success: false,
          error: `Payment invalid: ${verifyResult.invalidReason}`,
          code: "PAYMENT_INVALID",
        },
        { status: 402 },
      );
    }

    // 5. Auto-settle if configured
    let txHash = "";
    if (autoSettle) {
      try {
        const settleResult = await x402FacilitatorService.settle(
          parsedPaymentPayload,
          paymentRequirements,
        );
        txHash = settleResult.transaction;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[x402-middleware] Settlement error (non-blocking): ${msg}`);
        // Settlement failure is non-blocking — the payment was verified
      }
    }

    // 6. Inject payment context into request headers for the handler
    const paymentContext: X402PaymentContext = {
      payer: verifyResult.payer ?? "",
      amount: config.price,
      network,
      verified: true,
    };

    // Clone request with added context header
    const headers = new Headers(request.headers);
    headers.set(X402_CONTEXT_HEADER, JSON.stringify(paymentContext));
    const paidRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
    });

    // 7. Call the handler
    const response = await handler(paidRequest, routeContext);

    // 8. Add payment receipt headers to response
    const responseHeaders = new Headers(response.headers);
    if (txHash) {
      responseHeaders.set("X-PAYMENT-RESPONSE", txHash);
    }
    responseHeaders.set("X-PAYMENT-STATUS", "verified");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  };
}

/**
 * Extract x402 payment context from a request (for use inside handlers).
 */
export function getX402PaymentContext(request: Request): X402PaymentContext | null {
  const header = request.headers.get(X402_CONTEXT_HEADER);
  if (!header) return null;

  try {
    return JSON.parse(header) as X402PaymentContext;
  } catch {
    return null;
  }
}

// Helpers

/**
 * Build a 402 Payment Required response with proper headers.
 */
function buildPaymentRequiredResponse(
  price: string,
  network: string,
  payTo: string,
  description: string,
  mimeType: string,
  maxTimeoutSeconds: number,
  resource: string,
): Response {
  const usdcAddress = getUsdcAddress(network);

  const paymentRequired = {
    x402Version: 2,
    accepts: [
      {
        scheme: "upto",
        network,
        maxAmountRequired: price,
        resource,
        description,
        mimeType,
        payTo,
        maxTimeoutSeconds,
        asset: usdcAddress,
        extra: {
          name: getUsdcDomainName(network),
          version: "2",
        },
      },
    ],
  };

  const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

  return new Response(
    JSON.stringify({
      success: false,
      error: "Payment Required",
      code: "PAYMENT_REQUIRED",
      x402Version: 2,
      accepts: paymentRequired.accepts,
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "Payment-Required": encoded,
        "Access-Control-Expose-Headers": "Payment-Required",
      },
    },
  );
}

/**
 * Get the USDC contract address for a given network.
 */
function getUsdcDomainName(network: string): string {
  // Ethereum mainnet uses "USD Coin", all others use "USDC"
  return network === "eip155:1" ? "USD Coin" : "USDC";
}

function getUsdcAddress(network: string): string {
  const addresses: Record<string, string> = {
    "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "eip155:11155111": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  };
  return addresses[network] ?? addresses["eip155:8453"];
}
