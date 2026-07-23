/** Local-calendar date keys shared by the Simple Views service and renderer. */

export function todayDateKey(date = new Date()): string {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
    .toISOString()
    .slice(0, 10);
}
