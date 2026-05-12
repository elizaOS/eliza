/**
 * Database error utilities for handling common Postgres error cases.
 */

/**
 * PostgreSQL unique violation (23505).
 * Detects when a database insert fails due to a unique constraint violation.
 * Recursively follows error.cause chain to handle wrapped DB errors.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    const cause = (error as { cause?: unknown }).cause;
    return (
      error.message.includes("unique constraint") ||
      error.message.includes("duplicate key") ||
      code === "23505" ||
      (cause !== undefined && isUniqueConstraintError(cause))
    );
  }
  return false;
}
