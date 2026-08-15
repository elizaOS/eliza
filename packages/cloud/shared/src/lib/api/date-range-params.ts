/** Validates the optional date range shared by app analytics routes. */
export type DateRangeParams =
  | { success: true; startDate?: Date; endDate?: Date }
  | { success: false; error: string };

export function parseDateRangeParams(searchParams: URLSearchParams): DateRangeParams {
  const rawStart = searchParams.get("start_date");
  const rawEnd = searchParams.get("end_date");
  const startDate = rawStart === null ? undefined : new Date(rawStart);
  const endDate = rawEnd === null ? undefined : new Date(rawEnd);

  if (startDate && Number.isNaN(startDate.getTime())) {
    return { success: false, error: "Invalid start_date" };
  }
  if (endDate && Number.isNaN(endDate.getTime())) {
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
