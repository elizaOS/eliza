// Minimal Cloudflare Worker that mounts ONE MCP route (the time MCP) at
//   POST /mcps/time/streamable-http
// using `mcp-handler`'s createMcpHandler + StreamableHttp transport.
//
// Goal: verify whether the mcp-handler / @modelcontextprotocol/sdk stack
// builds and bundles for workerd under nodejs_compat. This file is the
// SOLE entrypoint for the smoke harness so any build error is clearly
// about the MCP stack, not the rest of cloud.
//
// This is a temporary smoke test. Delete this directory once the mcp-handler
// verdict is recorded in cloud/api/MCP_WORKERS_VERIFICATION.md.

import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const app = new Hono();

// ---- Time MCP (trimmed from the original cloud route) -----------------------

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

function createHandler() {
  return createMcpHandler(
    (server) => {
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
    },
    {
      capabilities: { tools: {} },
    },
    {
      // No Redis on the smoke harness — exercises the in-memory path.
      streamableHttpEndpoint: "/mcps/time/streamable-http",
      disableSse: true,
      maxDuration: 30,
    },
  );
}

async function handleTransportRequest(request: Request): Promise<Response> {
  const handler = createHandler();
  return await handler(request);
}

app.all("/mcps/time/streamable-http", (c) => handleTransportRequest(c.req.raw));

app.get("/", (c) =>
  c.json({
    ok: true,
    name: "cloud-mcp-smoke",
    routes: ["POST /mcps/time/streamable-http"],
  }),
);

export default app;
