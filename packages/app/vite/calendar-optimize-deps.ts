/**
 * Selects calendar dependencies that Vite can safely pre-bundle.
 *
 * Calendar-system packages are optional in react-day-picker. The optimizer
 * treats every listed package as required, so entries must track successful
 * package resolution instead of the calendar integrations the app may support.
 */

export interface CalendarOptimizeDepEntries {
  reactDayPickerEntry?: string;
  dateFnsEntry?: string;
  dateFnsLocaleEntry?: string;
  dateFnsJalaliEntry?: string;
  dateFnsJalaliLocaleEntry?: string;
}

export function calendarOptimizeDeps(
  entries: CalendarOptimizeDepEntries,
): string[] {
  return [
    ...(entries.reactDayPickerEntry ? ["react-day-picker"] : []),
    ...(entries.dateFnsEntry ? ["date-fns"] : []),
    ...(entries.dateFnsLocaleEntry ? ["date-fns/locale"] : []),
    ...(entries.dateFnsJalaliEntry ? ["date-fns-jalali"] : []),
    ...(entries.dateFnsJalaliLocaleEntry ? ["date-fns-jalali/locale"] : []),
  ];
}
