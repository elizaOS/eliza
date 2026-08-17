/** Validates the optional date range shared by app analytics routes. */
export type DateRangeParams =
  | { success: true; startDate?: Date; endDate?: Date }
  | { success: false; error: string };

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseOptionalDate(raw: string | null): Date | undefined {
  if (raw === null) return undefined;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  if (ISO_DATE_ONLY.test(raw) && date.toISOString().slice(0, 10) !== raw) {
    return undefined;
  }
  return date;
}

export function parseDateRangeParams(searchParams: URLSearchParams): DateRangeParams {
  const rawStart = searchParams.get("start_date");
  const rawEnd = searchParams.get("end_date");
  const startDate = parseOptionalDate(rawStart);
  const endDate = parseOptionalDate(rawEnd);

  if (rawStart !== null && !startDate) {
    return { success: false, error: "Invalid start_date" };
  }
  if (rawEnd !== null && !endDate) {
    return { success: false, error: "Invalid end_date" };
  }
  if (startDate && endDate && startDate > endDate) {
    return {
      success: false,
      error: "start_date must not be after end_date",
    };
  }
  return { success: true, startDate, endDate };
}
