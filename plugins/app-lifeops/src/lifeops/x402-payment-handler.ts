/**
 * x402 (HTTP 402 Payment Required) handler for Eliza Cloud relays.
 *
 * Spec reference: https://www.x402.org
 *
 * When the user's Cloud credit balance can't cover a metered call, the
 * Cloud relay returns HTTP 402 with a `payment-requirements` envelope —
 * either as a `WWW-Authenticate: x402 <json>` header or as a JSON body
 * with a top-level `paymentRequirements` array. Each requirement
 * describes one acceptable payment option (asset, network, recipient,
 * amount).
 *
 * This module is intentionally thin:
 *   - `parseX402Response` extracts requirements from a Response.
 *   - `PaymentRequiredError` carries them up to the action layer.
 *   - `requestPayment` is the agent-side bridge: today it surfaces the
 *     requirement back to the owner via the runtime logger so the UI /
 *     planner can route the user to the existing wallet top-up flow.
 *     Auto-pay is intentionally not implemented here — the actual money
 *     movement is Cloud-side and gated by the wallet UI (commandment 4).
 *
 * No silent failures: a malformed 402 throws so the action layer can
 * surface a clear "payment-required" message rather than treating the
 * upstream as a generic HTTP error.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";

/**
 * One acceptable payment option as advertised by the server.
 *
 * Fields mirror the x402 spec's `paymentRequirements` entry. We type
 * everything as required so silent partial parses are impossible — the
 * parser either yields a complete requirement or rejects it.
 */
export interface X402PaymentRequirement {
  /** Decimal amount in the asset's smallest unit (e.g. "1500000" for
   *  1.50 USDC). String, not number, to preserve precision. */
  readonly amount: string;
  /** Asset symbol or ERC-20 contract address (e.g. "USDC"). */
  readonly asset: string;
  /** Network identifier (e.g. "base", "ethereum", "solana"). */
  readonly network: string;
  /** Recipient address that should receive the payment. */
  readonly payTo: string;
  /** Payment scheme — currently x402 supports "exact" only. */
  readonly scheme: string;
  /** ISO-8601 deadline after which the requirement is no longer valid. */
  readonly expiresAt: string | null;
  /** Human-readable description of the resource being purchased. */
  readonly description: string | null;
}

/**
 * Wire shape we accept from JSON bodies. Loose at the boundary, strict
 * after parsing.
 */
interface RawRequirement {
  readonly amount?: unknown;
  readonly asset?: unknown;
  readonly network?: unknown;
  readonly payTo?: unknown;
  readonly scheme?: unknown;
  readonly expiresAt?: unknown;
  readonly description?: unknown;
}

interface RawX402Body {
  readonly paymentRequirements?: ReadonlyArray<RawRequirement>;
  readonly accepts?: ReadonlyArray<RawRequirement>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readAmount(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeRequirement(
  raw: RawRequirement | null | undefined,
): X402PaymentRequirement | null {
  if (!raw || typeof raw !== "object") return null;
  const amount = readAmount(raw.amount);
  const asset = readString(raw.asset);
  const network = readString(raw.network);
  const payTo = readString(raw.payTo);
  if (!amount || !asset || !network || !payTo) return null;
  const scheme = readString(raw.scheme) ?? "exact";
  return {
    amount,
    asset,
    network,
    payTo,
    scheme,
    expiresAt: readString(raw.expiresAt),
    description: readString(raw.description),
  };
}

function parseRequirementsArray(
  raw: ReadonlyArray<RawRequirement> | undefined,
): X402PaymentRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: X402PaymentRequirement[] = [];
  for (const entry of raw) {
    const normalized = normalizeRequirement(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Pull payment requirements out of an x402 response. Tries the header
 * form first (lowest-overhead per spec), then falls back to the JSON
 * body. Returns `null` when the response carries no parseable
 * requirements — callers should treat that as a generic 402 and
 * surface the upstream status text.
 */
export async function parseX402Response(
  response: Response,
): Promise<X402PaymentRequirement[] | null> {
  const headerValue = response.headers.get("www-authenticate");
  if (headerValue?.toLowerCase().startsWith("x402")) {
    const jsonPart = headerValue.slice(4).trim();
    if (jsonPart.length > 0) {
      const parsed = JSON.parse(jsonPart) as RawX402Body | RawRequirement[];
      const requirements = Array.isArray(parsed)
        ? parseRequirementsArray(parsed)
        : parseRequirementsArray(parsed.paymentRequirements ?? parsed.accepts);
      if (requirements.length > 0) return requirements;
    }
  }
  // Fall back to body parse. Clone so the caller can still read it.
  const cloned = response.clone();
  const text = await cloned.text();
  if (text.length === 0) return null;
  const body = JSON.parse(text) as RawX402Body;
  const requirements = parseRequirementsArray(
    body.paymentRequirements ?? body.accepts,
  );
  return requirements.length > 0 ? requirements : null;
}

/**
 * Thrown by adapters when an upstream metered call returns 402 with
 * actionable payment requirements. Action handlers convert this into an
 * approval-queue entry so the user sees both the cost and the
 * top-up prompt together.
 */
export class PaymentRequiredError extends Error {
  readonly code = "PAYMENT_REQUIRED" as const;
  readonly requirements: ReadonlyArray<X402PaymentRequirement>;

  constructor(
    requirements: ReadonlyArray<X402PaymentRequirement>,
    message?: string,
  ) {
    const text =
      message ??
      `Eliza Cloud returned HTTP 402 — your credit balance can't cover this call. ${requirements.length} payment option(s) available.`;
    super(text);
    this.name = "PaymentRequiredError";
    this.requirements = requirements;
  }
}

export interface PaymentReceipt {
  readonly status: "surfaced" | "paid";
  readonly requirement: X402PaymentRequirement;
  /** Transaction id when status === "paid", null when only surfaced. */
  readonly txId: string | null;
}

/**
 * Bridge from a raw payment requirement to user action. For now this
 * does not auto-pay: the actual money movement happens in the existing
 * wallet UI (Cloud-side). We log the requirement so the agent's
 * messaging surface and the desktop dev console both pick it up, then
 * return a "surfaced" receipt for the action layer to forward into the
 * approval queue.
 */
export async function requestPayment(
  runtime: IAgentRuntime,
  requirements: ReadonlyArray<X402PaymentRequirement>,
): Promise<PaymentReceipt> {
  if (requirements.length === 0) {
    throw new Error(
      "[x402] requestPayment called with no requirements — adapter bug",
    );
  }
  const preferred = requirements[0];
  logger.warn(
    {
      boundary: "lifeops",
      integration: "x402",
      asset: preferred.asset,
      network: preferred.network,
      amount: preferred.amount,
      runtimeId: runtime.agentId,
    },
    `[x402] payment-required: ${preferred.amount} ${preferred.asset} on ${preferred.network} → ${preferred.payTo}${preferred.description ? ` (${preferred.description})` : ""}`,
  );
  return { status: "surfaced", requirement: preferred, txId: null };
}
