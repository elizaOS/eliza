/**
 * Calendar service error. Carries an HTTP status code so route handlers can map
 * domain failures onto responses. Mirrors the LifeOps `LifeOpsServiceError`
 * shape so existing callers translate cleanly.
 */
export class CalendarServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CalendarServiceError";
  }
}

export function fail(status: number, message: string, code?: string): never {
  throw new CalendarServiceError(status, message, code);
}
