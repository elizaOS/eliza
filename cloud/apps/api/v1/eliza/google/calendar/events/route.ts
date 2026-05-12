/**
 * POST /api/v1/eliza/google/calendar/events
 *
 * Creates a Google Calendar event via the managed Google connector.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  createManagedGoogleCalendarEvent,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const attendeeSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).optional(),
  optional: z.boolean().optional(),
});

const requestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  grantId: z.string().trim().min(1).optional(),
  calendarId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  startAt: z.string().trim().min(1),
  endAt: z.string().trim().min(1),
  timeZone: z.string().trim().min(1),
  attendees: z.array(attendeeSchema).optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid calendar event request.",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const event = await createManagedGoogleCalendarEvent({
      organizationId: user.organization_id,
      userId: user.id,
      side: parsed.data.side ?? "owner",
      grantId: parsed.data.grantId,
      calendarId: parsed.data.calendarId ?? "primary",
      title: parsed.data.title,
      description: parsed.data.description,
      location: parsed.data.location,
      startAt: parsed.data.startAt,
      endAt: parsed.data.endAt,
      timeZone: parsed.data.timeZone,
      attendees: parsed.data.attendees,
    });
    return c.json(event, 201);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
