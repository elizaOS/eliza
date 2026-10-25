/** Validates the optional date range shared by app analytics routes. */
export type DateRangeParams =
  | { success: true; startDate?: Date; endDate?: Date }
  | { success: false; error: string };

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

function isRealCivilDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() + 1 === month &&
    probe.getUTCDate() === day
  );
}

function parseOptionalDate(raw: string | null): Date | undefined {
  if (raw === null) return undefined;

  const prefix = ISO_DATE_PREFIX.exec(raw);
  if (prefix && !isRealCivilDay(Number(prefix[1]), Number(prefix[2]), Number(prefix[3]))) {
    return undefined;
  }

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
