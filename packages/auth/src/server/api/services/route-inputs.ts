const MAX_CUSTOM_TOKEN_BALANCES = 25;

export function normalizeOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

export function parseCustomTokenList(
  value: string | undefined,
): string[] | string | undefined {
  if (!value) return undefined;
  if (value.length > 2_500) return "tokens query is too long";
  const tokens = [
    ...new Set(
      value
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
  if (tokens.length > MAX_CUSTOM_TOKEN_BALANCES) {
    return `tokens cannot contain more than ${MAX_CUSTOM_TOKEN_BALANCES} addresses`;
  }
  for (const token of tokens) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(token))
      return "tokens must be comma-separated EVM addresses";
  }
  return tokens;
}

export function parseOptionalChainId(
  value: string | undefined,
): number | string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) return "chainId must be a positive integer";
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    return "chainId must be a positive integer";
  return chainId;
}

export function normalizeInvitationExpiry(value: unknown): Date {
  const maxSeconds = 30 * 24 * 60 * 60;
  const defaultSeconds = 7 * 24 * 60 * 60;
  const seconds =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, maxSeconds)
      : defaultSeconds;
  return new Date(Date.now() + seconds * 1000);
}

export function parseDurationSeconds(value: string): number | null {
  const match = value.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "s"
      ? 1
      : unit === "m"
        ? 60
        : unit === "h"
          ? 60 * 60
          : 24 * 60 * 60;
  return amount * multiplier;
}

export function parseHttpTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isSafeInteger(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBasicAuth(
  value: string | undefined | null,
): { username: string; password: string } | null {
  if (!value?.startsWith("Basic ")) return null;
  let decoded = "";
  try {
    decoded = atob(value.slice(6));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}
