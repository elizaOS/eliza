export interface CreditTransactionsQuery {
  limit: number;
  hours: number | null;
}

const MAX_LIMIT = 200;
const MAX_HOURS = 24 * 365;

function parsePositiveIntegerParam(
  value: string | undefined,
  name: string,
  fallback: number | null,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (parsed > max) {
    throw new Error(`${name} must be less than or equal to ${max}`);
  }
  return parsed;
}

export function parseCreditTransactionsQuery(params: {
  limit?: string;
  hours?: string;
}): CreditTransactionsQuery {
  return {
    limit:
      parsePositiveIntegerParam(params.limit, "limit", 100, MAX_LIMIT) ?? 100,
    hours: parsePositiveIntegerParam(params.hours, "hours", null, MAX_HOURS),
  };
}
