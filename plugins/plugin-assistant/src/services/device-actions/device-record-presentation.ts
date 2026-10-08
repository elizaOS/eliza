/** Exact local labels for persisted reminder receipt instants. */
export function formatDeviceRecordDateTime(
  value: string | number,
  timeZone: string,
): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(date.getUTCSeconds() || date.getUTCMilliseconds()
      ? { second: "2-digit" as const }
      : {}),
    ...(date.getUTCMilliseconds()
      ? { fractionalSecondDigits: 3 as const }
      : {}),
    timeZoneName: "short",
  }).format(date);
}
