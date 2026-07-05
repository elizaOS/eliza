/**
 * Fail-closed numeric boundary for the MCP `withCredits()` balance pre-check
 * (#13415, cloud-shared money-layer fallback-slop sweep).
 *
 * `organizations.credit_balance` is a Postgres NUMERIC column, so the driver
 * hands it back as a string. Before this slice, `withCredits()` in
 * `mcp/helpers.ts` gated a PAID MCP tool call on:
 *
 *   if (Number(context.org.credit_balance) < toolCost) throw
 *
 * A corrupt `credit_balance` (`'NaN'::numeric` is a valid Postgres NUMERIC, and
 * a migration artifact or manual DB edit can produce a non-parseable string)
 * reads back as `"NaN"`, and `Number("NaN") < toolCost` is `false`, so the
 * insufficient-credit gate is BYPASSED and the tool proceeds to the paid
 * `deductCredits` path against an unreadable balance. Any JS-only coercion
 * (`"1e3"`, `"0x10"`, `"Infinity"`) that `Number(...)` accepts or turns into
 * `NaN` is likewise mishandled by the bare comparison. A money-out gate failing
 * OPEN is the worst class of this bug.
 *
 * Failing closed here surfaces the corruption with a distinct error BEFORE the
 * gate can be bypassed — the caller (the MCP tool boundary) already throws on
 * insufficient credits, so a corrupt balance now denies the tool call and
 * reports the poisoned value for repair instead of granting free execution.
 *
 * The regex only accepts a plain signed decimal (the exact shape Postgres
 * NUMERIC emits). A genuine explicit zero balance is a legitimate domain value
 * and parses to `0` (the tool is then correctly denied by the `< toolCost`
 * comparison, not by this boundary).
 *
 * error-policy:J1 — corrupt stored money value on a spend gate: deny, surface
 * for repair, never fabricate an authorized-spend default.
 */
import { ElizaError } from "@elizaos/core";

export class CorruptMcpCreditBalanceError extends ElizaError {
  override readonly name = "CorruptMcpCreditBalanceError";
  readonly rawValue: unknown;

  constructor(rawValue: unknown, reason: string) {
    super(`Unable to read organization credit_balance for MCP spend gate: ${reason}`, {
      code: "CORRUPT_MCP_CREDIT_BALANCE",
      context: { rawValue, reason },
      severity: "fatal",
    });
    this.rawValue = rawValue;
  }
}

/**
 * Parse an organization `credit_balance` NUMERIC value fail-closed for the MCP
 * `withCredits()` spend gate.
 *
 * @throws {CorruptMcpCreditBalanceError} when the value is missing, empty, not a
 *   plain NUMERIC string, or not a finite number.
 */
export function parseMcpCreditBalance(value: string | number | null | undefined): number {
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new CorruptMcpCreditBalanceError(value, "value is empty or missing");
  }
  if (typeof value === "string" && !/^[+-]?(?:\d+|\d*\.\d+)$/.test(value.trim())) {
    throw new CorruptMcpCreditBalanceError(value, "value is not a valid NUMERIC");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CorruptMcpCreditBalanceError(value, "value is not a finite number");
  }
  return parsed;
}
