import { Hono } from "hono";
import { z } from "zod";
import { agentGoogleRouteDeps } from "@/lib/services/agent-google-route-deps";
import type { AppEnv } from "@/types/cloud-worker-env";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const attendeeSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).optional(),
  optional: z.boolean().optional(),
});

const patchRequestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  grantId: z.string().trim().min(1).optional(),
  calendarId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  startAt: z.string().trim().min(1).optional(),
  endAt: z.string().trim().min(1).optional(),
  timeZone: z.string().trim().min(1).optional(),
  attendees: z.array(attendeeSchema).optional(),
});

async function __hono_PATCH(request: Request, { params }: RouteParams) {
  try {
    const { user } = await agentGoogleRouteDeps.requireAuthOrApiKeyWithOrg(request);
    const { eventId } = await params;
    const parsed = patchRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid calendar event update request.",
          details: parsed.error.issues,
        },
        { status: 400 },
      );
    }

    return Response.json(
      await agentGoogleRouteDeps.updateManagedGoogleCalendarEvent({
        organizationId: user.organization_id,
        userId: user.id,
        side: parsed.data.side ?? "owner",
        grantId: parsed.data.grantId,
        calendarId: parsed.data.calendarId ?? "primary",
        eventId,
        title: parsed.data.title,
        description: parsed.data.description,
        location: parsed.data.location,
        startAt: parsed.data.startAt,
        endAt: parsed.data.endAt,
        timeZone: parsed.data.timeZone,
        attendees: parsed.data.attendees,
      }),
    );
  } catch (error) {
    if (error instanceof agentGoogleRouteDeps.AgentGoogleConnectorError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to update Google Calendar event.",
      },
      { status: 500 },
    );
  }
}

async function __hono_DELETE(request: Request, { params }: RouteParams) {
  try {
    const { user } = await agentGoogleRouteDeps.requireAuthOrApiKeyWithOrg(request);
    const { eventId } = await params;
    const sideRaw = new URL(request.url).searchParams.get("side");
    const grantId = new URL(request.url).searchParams.get("grantId")?.trim() || undefined;
    const calendarIdRaw = new URL(request.url).searchParams.get("calendarId");
    if (sideRaw && sideRaw !== "owner" && sideRaw !== "agent") {
      return Response.json({ error: "Invalid calendar event delete request." }, { status: 400 });
    }
    if (calendarIdRaw !== null && calendarIdRaw.trim().length === 0) {
      return Response.json({ error: "Invalid calendar event delete request." }, { status: 400 });
    }

    return Response.json(
      await agentGoogleRouteDeps.deleteManagedGoogleCalendarEvent({
        organizationId: user.organization_id,
        userId: user.id,
        side: (sideRaw as "owner" | "agent" | null) ?? "owner",
        grantId,
        calendarId: calendarIdRaw?.trim() || "primary",
        eventId,
      }),
    );
  } catch (error) {
    if (error instanceof agentGoogleRouteDeps.AgentGoogleConnectorError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Failed to delete Google Calendar event.",
      },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.patch("/", async (c) =>
  __hono_PATCH(c.req.raw, { params: Promise.resolve({ eventId: c.req.param("eventId")! }) }),
);
__hono_app.delete("/", async (c) =>
  __hono_DELETE(c.req.raw, { params: Promise.resolve({ eventId: c.req.param("eventId")! }) }),
);
export default __hono_app;
