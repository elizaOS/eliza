/**
 * Time & date MCP tools (Workers-safe). Ported from services/_smoke-mcp/worker.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TIMEZONE_ALIASES: Record<string, string> = {
  EST: "America/New_York",
  PST: "America/Los_Angeles",
  GMT: "Etc/GMT",
  UTC: "UTC",
  JST: "Asia/Tokyo",
};

function resolveTimezone(tz: string): string {
  const upper = tz.toUpperCase().replace(/[- ]/g, "_");
  return TIMEZONE_ALIASES[upper] ?? tz;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerTimeMcpTools(server: McpServer): void {
  server.tool(
    "get_current_time",
    "Get the current date and time in various formats for any timezone.",
    {
      timezone: z
        .string()
        .optional()
        .default("UTC")
        .describe("IANA timezone or alias (e.g. 'PST', 'JST')"),
      format: z.enum(["iso", "unix", "readable", "all"]).optional().default("all"),
    },
    async ({ timezone = "UTC", format = "all" }) => {
      const tz = resolveTimezone(timezone);
      if (!isValidTimezone(tz)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Invalid timezone: ${timezone}` }),
            },
          ],
          isError: true,
        };
      }
      const now = new Date();
      const iso = now.toISOString();
      const unix = Math.floor(now.getTime() / 1000);
      const readable = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      const payload =
        format === "iso"
          ? { iso }
          : format === "unix"
            ? { unix }
            : format === "readable"
              ? { readable, timezone: tz }
              : { iso, unix, readable, timezone: tz };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
