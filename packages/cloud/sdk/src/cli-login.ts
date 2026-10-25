/** Validates server-minted Cloud CLI login session identifiers at trust boundaries. */

const CLI_LOGIN_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCliLoginSessionId(value: unknown): value is string {
  return typeof value === "string" && CLI_LOGIN_SESSION_ID_PATTERN.test(value);
}
