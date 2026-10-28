/** Only fixed PostgreSQL categories may leave the private qualification log. */
export function sharedRecallFailureCode(error: unknown): string {
  const allowed = new Set([
    "23502",
    "23503",
    "23505",
    "42703",
    "42P01",
    "42501",
    "28P01",
    "3D000",
    "08006",
    "57014",
  ]);
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== "object" || current === null) break;
    const code = Object.getOwnPropertyDescriptor(current, "code");
    if (
      code &&
      "value" in code &&
      typeof code.value === "string" &&
      allowed.has(code.value)
    ) {
      return code.value;
    }
    const cause = Object.getOwnPropertyDescriptor(current, "cause");
    current = cause && "value" in cause ? cause.value : undefined;
  }
  return "UNKNOWN";
}
