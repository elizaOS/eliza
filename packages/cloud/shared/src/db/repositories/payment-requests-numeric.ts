/**
 * Numeric parsing boundary for payment-request money fields.
 *
 * `payment_requests.amount_cents` is a NOT NULL `bigint` column. Drizzle's
 * `bigint` mode hands it back as a JS `bigint`, but depending on the driver /
 * raw-query path a money column can also surface as a `string` or `number`.
 * Reading it with a bare `Number(...)` silently fails open in two ways:
 *
 *   1. `Number(veryLargeBigInt)` loses precision above `2^53 - 1`, so the
 *      amount that reaches the Stripe adapter (`unit_amount: request.amountCents`)
 *      no longer equals the amount that was authorized — a mischarge.
 *   2. `Number(<malformed string>)` yields `NaN`, and the adapter's
 *      `if (request.amountCents <= 0)` reject guard evaluates `NaN <= 0` as
 *      `false`, so a request with no readable amount slips past the
 *      zero/negative-amount check and a checkout session is created for `NaN`.
 *
 * This boundary makes a corrupt/unreadable money read throw instead of
 * fabricating a finite number, so the caller fails closed.
 */

/** Largest cents value that survives a lossless `bigint -> number` round-trip. */
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export function parsePaymentAmountCents(
  value: bigint | string | number | null | undefined,
  fieldName: string,
): number {
  if (value === null || value === undefined) {
    throw new Error(`Unable to read payment ${fieldName}: value is empty or missing`);
  }

  // Preserve exact integer semantics for bigint reads: reject values that would
  // lose precision when narrowed to a JS number rather than silently truncating.
  if (typeof value === "bigint") {
    if (value > MAX_SAFE_CENTS || value < -MAX_SAFE_CENTS) {
      throw new Error(
        `Unable to read payment ${fieldName}: value ${value} exceeds safe integer range`,
      );
    }
    if (value < 0n) {
      throw new Error(`Unable to read payment ${fieldName}: value is negative`);
    }
    return Number(value);
  }

  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`Unable to read payment ${fieldName}: value is empty or missing`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unable to read payment ${fieldName}: value is not a finite number`);
  }
  if (!Number.isInteger(parsed)) {
    throw new Error(`Unable to read payment ${fieldName}: value is not an integer`);
  }
  if (parsed < 0) {
    throw new Error(`Unable to read payment ${fieldName}: value is negative`);
  }
  return parsed;
}
