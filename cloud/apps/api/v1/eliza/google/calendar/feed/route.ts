/**
 * GET /api/v1/eliza/google/calendar/feed
 *
 * Returns the Google Calendar feed (events between timeMin/timeMax) via the
 * managed Google connector.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  fetchManagedGoogleCalendarFeed,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    const grantId = c.req.query("grantId")?.trim() || undefined;
    const calendarId = c.req.query("calendarId")?.trim() || "primary";
    const timeMin = c.req.query("timeMin")?.trim();
    const timeMax = c.req.query("timeMax")?.trim();
    const timeZone = c.req.query("timeZone")?.trim() || "UTC";

    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    if (!timeMin || !timeMax) {
      return c.json({ error: "timeMin and timeMax are required." }, 400);
    }

    const feed = await fetchManagedGoogleCalendarFeed({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId,
      calendarId,
      timeMin,
      timeMax,
      timeZone,
    });
    return c.json(feed);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
