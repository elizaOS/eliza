/**
 * Validates the server-owned Dedicated activation terms shared by the visible
 * review dialog and the orchestration client. Invalid or unsupported wire data
 * is unavailable, never a price or permission that can be confirmed.
 */

export interface DedicatedActivationConfirmationQuote {
  quoteId: string;
  quoteVersion: "personal-dedicated-v1";
  issuedAt: number;
  expiresAt: number;
  hourlyRateUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  canActivate: boolean;
  requiresConfirmation: true;
  action: "activate_dedicated";
  activation:
    | { state: "available" }
    | { state: "in_progress"; dedicatedAgentId: string; status: string };
  unavailableReason?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseDedicatedActivationQuote(
  value: unknown,
): DedicatedActivationConfirmationQuote | null {
  const quote = record(value);
  const quoteId = text(quote?.quoteId);
  const activation = record(quote?.activation);
  const state = text(activation?.state);
  const dedicatedAgentId = text(activation?.dedicatedAgentId);
  const status = text(activation?.status);
  const hourlyRateUsd = finiteNumber(quote?.hourlyRateUsd);
  const dailyRateUsd = finiteNumber(quote?.dailyRateUsd);
  const minimumBalanceUsd = finiteNumber(quote?.minimumBalanceUsd);
  const minimumRunwayDays = finiteNumber(quote?.minimumRunwayDays);
  const balanceUsd = finiteNumber(quote?.balanceUsd);
  const deficitUsd = finiteNumber(quote?.deficitUsd);
  const issuedAt = finiteNumber(quote?.issuedAt);
  const expiresAt = finiteNumber(quote?.expiresAt);
  if (
    !quoteId ||
    !/^[a-f0-9]{64}$/.test(quoteId) ||
    quote?.quoteVersion !== "personal-dedicated-v1" ||
    issuedAt === null ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    expiresAt === null ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    hourlyRateUsd === null ||
    hourlyRateUsd < 0 ||
    dailyRateUsd === null ||
    dailyRateUsd < 0 ||
    minimumBalanceUsd === null ||
    minimumBalanceUsd < 0 ||
    minimumRunwayDays === null ||
    minimumRunwayDays < 0 ||
    balanceUsd === null ||
    deficitUsd === null ||
    deficitUsd < 0 ||
    typeof quote.canActivate !== "boolean" ||
    quote.requiresConfirmation !== true ||
    quote.action !== "activate_dedicated"
  )
    return null;
  let target: DedicatedActivationConfirmationQuote["activation"];
  if (state === "available") target = { state };
  else if (state === "in_progress" && dedicatedAgentId && status) {
    target = { state, dedicatedAgentId, status };
  } else return null;
  const unavailableReason = text(quote.unavailableReason);
  return {
    quoteId,
    quoteVersion: "personal-dedicated-v1",
    issuedAt,
    expiresAt,
    hourlyRateUsd,
    dailyRateUsd,
    minimumBalanceUsd,
    minimumRunwayDays,
    balanceUsd,
    deficitUsd,
    canActivate: quote.canActivate,
    requiresConfirmation: true,
    action: "activate_dedicated",
    activation: target,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

/** Client-side UX guard only; the server remains the consent authority. */
export function isDedicatedActivationQuoteCurrent(
  quote: Pick<DedicatedActivationConfirmationQuote, "issuedAt" | "expiresAt">,
  now = Date.now(),
): boolean {
  return now >= quote.issuedAt && now < quote.expiresAt;
}
