import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

export const maxDuration = 30;

// ============================================================================
// Time & Date Utilities
// Uses native JS Intl APIs for accurate timezone handling
// ============================================================================

// Common timezone aliases for convenience
const TIMEZONE_ALIASES: Record<string, string> = {
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  GMT: "Etc/GMT",
  BST: "Europe/London",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  CST_CHINA: "Asia/Shanghai",
  IST: "Asia/Kolkata",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  NZST: "Pacific/Auckland",
};

function resolveTimezone(tz: string): string {
  const upper = tz.toUpperCase().replace(/[- ]/g, "_");
  return TIMEZONE_ALIASES[upper] || tz;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Get list of common timezones
const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// ============================================================================
// MCP Handler
// ============================================================================

const handler = createMcpHandler(
  (server) => {
    // ========================================================================
    // Tool 1: Get Current Time
    // ========================================================================
    server.tool(
      "get_current_time",
      "Get the current date and time in various formats for any timezone.",
      {
        timezone: z
          .string()
          .optional()
          .default("UTC")
          .describe(
            "IANA timezone (e.g., 'America/New_York') or alias (e.g., 'PST', 'JST')",
          ),
        format: z
          .enum(["iso", "unix", "readable", "all"])
          .optional()
          .default("all")
          .describe("Output format"),
      },
      async ({ timezone = "UTC", format = "all" }) => {
        try {
          const tz = resolveTimezone(timezone);

          if (!isValidTimezone(tz)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: `Invalid timezone: '${timezone}'`,
                      suggestion:
                        "Use IANA format (e.g., 'America/New_York') or common aliases (e.g., 'PST', 'EST', 'JST')",
                      commonTimezones: COMMON_TIMEZONES.slice(0, 10),
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const now = new Date();

          const formatters = {
            date: new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              dateStyle: "full",
            }),
            time: new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              timeStyle: "long",
            }),
            datetime: new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              dateStyle: "full",
              timeStyle: "long",
            }),
          };

          const result: Record<string, string | number> = {
            timezone: tz,
          };

          if (format === "iso" || format === "all") {
            result.iso = now.toISOString();
            // Also provide localized ISO-like format
            result.localIso = new Intl.DateTimeFormat("sv-SE", {
              timeZone: tz,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
              .format(now)
              .replace(" ", "T");
          }
          if (format === "unix" || format === "all") {
            result.unix = Math.floor(now.getTime() / 1000);
            result.unixMs = now.getTime();
          }
          if (format === "readable" || format === "all") {
            result.date = formatters.date.format(now);
            result.time = formatters.time.format(now);
            result.datetime = formatters.datetime.format(now);
          }
          if (format === "all") {
            result.dayOfWeek = new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              weekday: "long",
            }).format(now);
            result.dayOfYear = Math.floor(
              (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) /
                86400000,
            );
            result.weekNumber = Math.ceil((result.dayOfYear as number) / 7);
            result.isLeapYear =
              (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) ||
              now.getFullYear() % 400 === 0
                ? 1
                : 0;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to get time",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 2: Convert Timezone
    // ========================================================================
    server.tool(
      "convert_timezone",
      "Convert a time between different timezones.",
      {
        time: z
          .string()
          .describe(
            "Time to convert (ISO format, e.g., '2024-01-15T14:30:00' or 'now')",
          ),
        fromTimezone: z
          .string()
          .describe("Source timezone (IANA format or alias)"),
        toTimezone: z
          .string()
          .describe("Target timezone (IANA format or alias)"),
      },
      async ({ time, fromTimezone, toTimezone }) => {
        try {
          const fromTz = resolveTimezone(fromTimezone);
          const toTz = resolveTimezone(toTimezone);

          if (!isValidTimezone(fromTz)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: `Invalid source timezone: '${fromTimezone}'` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          if (!isValidTimezone(toTz)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: `Invalid target timezone: '${toTimezone}'` },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const date =
            time.toLowerCase() === "now" ? new Date() : new Date(time);

          if (isNaN(date.getTime())) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      error: "Invalid time format",
                      suggestion:
                        "Use ISO format (e.g., '2024-01-15T14:30:00') or 'now'",
                    },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const fromFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: fromTz,
            dateStyle: "full",
            timeStyle: "long",
          });

          const toFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: toTz,
            dateStyle: "full",
            timeStyle: "long",
          });

          // Calculate offset difference
          const getOffset = (tz: string) => {
            const str = new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              timeZoneName: "longOffset",
            }).format(date);
            const match = str.match(/GMT([+-]\d{1,2}):?(\d{2})?/);
            if (!match) return 0;
            const hours = parseInt(match[1]);
            const minutes = parseInt(match[2] || "0");
            return hours * 60 + (hours >= 0 ? minutes : -minutes);
          };

          const fromOffset = getOffset(fromTz);
          const toOffset = getOffset(toTz);
          const diffMinutes = toOffset - fromOffset;
          const diffHours = diffMinutes / 60;

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    original: {
                      timezone: fromTz,
                      formatted: fromFormatter.format(date),
                    },
                    converted: {
                      timezone: toTz,
                      formatted: toFormatter.format(date),
                    },
                    difference: {
                      hours: diffHours,
                      description:
                        diffHours === 0
                          ? "Same time"
                          : `${toTz} is ${Math.abs(diffHours)} hour${Math.abs(diffHours) !== 1 ? "s" : ""} ${diffHours > 0 ? "ahead of" : "behind"} ${fromTz}`,
                    },
                    iso: date.toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to convert timezone",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 3: Format Date
    // ========================================================================
    server.tool(
      "format_date",
      "Format a date in various styles and locales.",
      {
        date: z.string().describe("Date to format (ISO format or 'now')"),
        locale: z
          .string()
          .optional()
          .default("en-US")
          .describe(
            "Locale for formatting (e.g., 'en-US', 'de-DE', 'ja-JP', 'zh-CN')",
          ),
        timezone: z
          .string()
          .optional()
          .default("UTC")
          .describe("Timezone for display"),
      },
      async ({ date, locale = "en-US", timezone = "UTC" }) => {
        try {
          const tz = resolveTimezone(timezone);
          const dateObj =
            date.toLowerCase() === "now" ? new Date() : new Date(date);

          if (isNaN(dateObj.getTime())) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: "Invalid date format" },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const styles = ["short", "medium", "long", "full"] as const;
          const dateFormats: Record<string, string> = {};
          const timeFormats: Record<string, string> = {};
          const datetimeFormats: Record<string, string> = {};

          styles.forEach((s) => {
            dateFormats[s] = new Intl.DateTimeFormat(locale, {
              timeZone: tz,
              dateStyle: s,
            }).format(dateObj);

            timeFormats[s] = new Intl.DateTimeFormat(locale, {
              timeZone: tz,
              timeStyle: s,
            }).format(dateObj);

            datetimeFormats[s] = new Intl.DateTimeFormat(locale, {
              timeZone: tz,
              dateStyle: s,
              timeStyle: s,
            }).format(dateObj);
          });

          // Relative time
          const now = new Date();
          const diffMs = dateObj.getTime() - now.getTime();
          const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

          let relativeTime: string;
          const diffDays = Math.round(diffMs / 86400000);
          const diffHours = Math.round(diffMs / 3600000);
          const diffMinutes = Math.round(diffMs / 60000);

          if (Math.abs(diffDays) >= 1) {
            relativeTime = rtf.format(diffDays, "day");
          } else if (Math.abs(diffHours) >= 1) {
            relativeTime = rtf.format(diffHours, "hour");
          } else {
            relativeTime = rtf.format(diffMinutes, "minute");
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    locale,
                    timezone: tz,
                    dateFormats,
                    timeFormats,
                    datetimeFormats,
                    relative: relativeTime,
                    iso: dateObj.toISOString(),
                    components: {
                      year: dateObj.getUTCFullYear(),
                      month: dateObj.getUTCMonth() + 1,
                      day: dateObj.getUTCDate(),
                      hour: dateObj.getUTCHours(),
                      minute: dateObj.getUTCMinutes(),
                      second: dateObj.getUTCSeconds(),
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to format date",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 4: Calculate Time Difference
    // ========================================================================
    server.tool(
      "calculate_time_diff",
      "Calculate the difference between two dates/times with detailed breakdown.",
      {
        startDate: z.string().describe("Start date/time (ISO format or 'now')"),
        endDate: z.string().describe("End date/time (ISO format or 'now')"),
      },
      async ({ startDate, endDate }) => {
        try {
          const start =
            startDate.toLowerCase() === "now"
              ? new Date()
              : new Date(startDate);
          const end =
            endDate.toLowerCase() === "now" ? new Date() : new Date(endDate);

          if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { error: "Invalid date format" },
                    null,
                    2,
                  ),
                },
              ],
              isError: true,
            };
          }

          const diffMs = end.getTime() - start.getTime();
          const absDiffMs = Math.abs(diffMs);

          // Calculate all units
          const seconds = Math.floor(absDiffMs / 1000);
          const minutes = Math.floor(seconds / 60);
          const hours = Math.floor(minutes / 60);
          const days = Math.floor(hours / 24);
          const weeks = Math.floor(days / 7);
          const months = Math.floor(days / 30.44);
          const years = Math.floor(days / 365.25);

          // Human-readable breakdown
          const breakdown = {
            years: Math.floor(days / 365),
            months: Math.floor((days % 365) / 30),
            weeks: Math.floor((days % 30) / 7),
            days: days % 7,
            hours: hours % 24,
            minutes: minutes % 60,
            seconds: seconds % 60,
          };

          // Auto-select best unit for primary display
          let primaryUnit: string;
          let primaryValue: number;

          if (years >= 1) {
            primaryUnit = "years";
            primaryValue = years;
          } else if (months >= 1) {
            primaryUnit = "months";
            primaryValue = months;
          } else if (weeks >= 1) {
            primaryUnit = "weeks";
            primaryValue = weeks;
          } else if (days >= 1) {
            primaryUnit = "days";
            primaryValue = days;
          } else if (hours >= 1) {
            primaryUnit = "hours";
            primaryValue = hours;
          } else if (minutes >= 1) {
            primaryUnit = "minutes";
            primaryValue = minutes;
          } else {
            primaryUnit = "seconds";
            primaryValue = seconds;
          }

          // Build human-readable string
          const parts: string[] = [];
          if (breakdown.years)
            parts.push(
              `${breakdown.years} year${breakdown.years !== 1 ? "s" : ""}`,
            );
          if (breakdown.months)
            parts.push(
              `${breakdown.months} month${breakdown.months !== 1 ? "s" : ""}`,
            );
          if (breakdown.days)
            parts.push(
              `${breakdown.days} day${breakdown.days !== 1 ? "s" : ""}`,
            );
          if (breakdown.hours)
            parts.push(
              `${breakdown.hours} hour${breakdown.hours !== 1 ? "s" : ""}`,
            );
          if (breakdown.minutes)
            parts.push(
              `${breakdown.minutes} minute${breakdown.minutes !== 1 ? "s" : ""}`,
            );

          const humanReadable =
            parts.slice(0, 3).join(", ") || "less than a minute";

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    start: start.toISOString(),
                    end: end.toISOString(),
                    direction: diffMs >= 0 ? "future" : "past",
                    primary: {
                      value: primaryValue,
                      unit: primaryUnit,
                    },
                    humanReadable,
                    breakdown,
                    totals: {
                      milliseconds: absDiffMs,
                      seconds,
                      minutes,
                      hours,
                      days,
                      weeks,
                      months,
                      years,
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to calculate difference",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );

    // ========================================================================
    // Tool 5: List Timezones
    // ========================================================================
    server.tool(
      "list_timezones",
      "Get a list of common timezones with their current offsets.",
      {
        filter: z
          .string()
          .optional()
          .describe(
            "Filter timezones by region (e.g., 'America', 'Europe', 'Asia')",
          ),
      },
      async ({ filter }) => {
        try {
          const now = new Date();

          let timezones = COMMON_TIMEZONES;
          if (filter) {
            const filterLower = filter.toLowerCase();
            timezones = timezones.filter((tz) =>
              tz.toLowerCase().includes(filterLower),
            );
          }

          const results = timezones.map((tz) => {
            const formatter = new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              timeZoneName: "longOffset",
            });
            const parts = formatter.formatToParts(now);
            const offsetPart = parts.find((p) => p.type === "timeZoneName");

            const timeFormatter = new Intl.DateTimeFormat("en-US", {
              timeZone: tz,
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            });

            return {
              timezone: tz,
              offset: offsetPart?.value || "Unknown",
              currentTime: timeFormatter.format(now),
            };
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    filter: filter || "all",
                    count: results.length,
                    timezones: results,
                    aliases: Object.entries(TIMEZONE_ALIASES)
                      .slice(0, 10)
                      .map(([alias, tz]) => ({
                        alias,
                        timezone: tz,
                      })),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error:
                      error instanceof Error
                        ? error.message
                        : "Failed to list timezones",
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      },
    );
  },
  {
    capabilities: {
      tools: {},
    },
  },
  {
    redisUrl: process.env.REDIS_URL,
    basePath: "/api/mcps/time",
    maxDuration: 30,
  },
);

/**
 * GET /api/mcps/time/[transport]
 * POST /api/mcps/time/[transport]
 * DELETE /api/mcps/time/[transport]
 *
 * MCP transport endpoint for Time & Date utilities.
 * Handles tool invocations for time-related operations (get current time, convert timezone, format date, etc.).
 *
 * @param request - The Next.js request object.
 * @param context - Route context containing the transport parameter.
 * @returns MCP handler response.
 */
export { handler as GET, handler as POST, handler as DELETE };
