/** Production Family Operations adapter over owner-authorized local APIs. */

import type { ParentingAgreementView } from "../../lifeops/household/agreement-knowledge.js";
import type { MonthlyFamilyPacket } from "../../lifeops/family-coordination/index.js";
import type {
  SchoolCalendarRunReview,
  SchoolCalendarWorkflowStatus,
} from "../../lifeops/school/calendar-workflow.js";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  FamilyPacketView,
  LinkedCalendarView,
  Loadable,
  SchoolWorkflowView,
} from "./types.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string } | string;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return payload as T;
}

async function loadSection<T>(path: string, key: string): Promise<Loadable<T>> {
  try {
    const payload = await request<Record<string, T>>(path);
    return { status: "ready", data: payload[key] as T };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

function schoolView(
  status: SchoolCalendarWorkflowStatus,
  review: SchoolCalendarRunReview | null,
): SchoolWorkflowView {
  const state = status.lastRun?.state ?? "never_run";
  return {
    sourceId: status.sourceId,
    label: "Concord Public Schools calendar",
    state:
      state === "running" ||
      state === "unchanged" ||
      state === "awaiting_approval" ||
      state === "applied" ||
      state === "failed"
        ? state
        : "never_run",
    lastCheckedAt: status.lastRun?.updatedAt ?? null,
    sourceUrl: status.config?.landingPageUrl ?? "",
    runId: status.lastRun?.runId,
    changes: review?.plan?.changes.map((change) => ({
      kind: change.kind === "cancel" ? "remove" : change.kind,
      label:
        change.kind === "update"
          ? change.event.title
          : change.event.title,
    })),
    error: review?.errorMessage ?? undefined,
  };
}

function packetView(packet: MonthlyFamilyPacket): FamilyPacketView {
  const states = packet.sections.map((section) => section.state);
  return {
    packetId: packet.packetId,
    periodKey: packet.period.key,
    version: packet.version,
    createdAt: packet.createdAt,
    status: states.includes("contradictory")
      ? "contradictory"
      : states.includes("missing")
        ? "missing"
        : "complete",
    claims: packet.claims.map((claim) => ({
      id: claim.claimId,
      section: claim.section,
      text: claim.statement,
    })),
  };
}

async function loadSchool(): Promise<Loadable<SchoolWorkflowView>> {
  try {
    const status = await request<SchoolCalendarWorkflowStatus>(
      "/api/lifeops/family-workflows/school/status",
    );
    const review = status.lastRun?.runId
      ? await request<SchoolCalendarRunReview>(
          `/api/lifeops/family-workflows/school/runs/${encodeURIComponent(status.lastRun.runId)}`,
        )
      : null;
    return { status: "ready", data: schoolView(status, review) };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

async function loadPackets(): Promise<Loadable<FamilyPacketView[]>> {
  try {
    const payload = await request<{ packets: MonthlyFamilyPacket[] }>(
      "/api/lifeops/family-workflows/packets",
    );
    return { status: "ready", data: payload.packets.map(packetView) };
  } catch (error) {
    return {
      status: "unavailable",
      message: error instanceof Error ? error.message : "Service unavailable",
    };
  }
}

export const defaultFamilyOperationsAdapter: FamilyOperationsAdapter = {
  async load(): Promise<FamilyOperationsSnapshot> {
    const [agreements, calendarLinks, school, packets] = await Promise.all([
      loadSection<ParentingAgreementView[]>(
        "/api/lifeops/agreements",
        "agreements",
      ),
      loadSection<LinkedCalendarView[]>("/api/lifeops/calendar/links", "links"),
      loadSchool(),
      loadPackets(),
    ]);
    return { agreements, calendarLinks, school, packets };
  },
  async decideObligation(obligation, decision, reason) {
    const response = await request<{ obligation: typeof obligation }>(
      `/api/lifeops/agreements/obligations/${encodeURIComponent(obligation.id)}/decision`,
      { method: "POST", body: JSON.stringify({ decision, reason }) },
    );
    return response.obligation;
  },
  async listPins(artifactId) {
    const response = await request<{
      pins: Awaited<ReturnType<FamilyOperationsAdapter["listPins"]>>;
    }>(`/api/lifeops/agreements/${encodeURIComponent(artifactId)}/pins`);
    return response.pins;
  },
  async pin(input) {
    const response = await request<{
      pin: Awaited<ReturnType<FamilyOperationsAdapter["pin"]>>;
    }>(`/api/lifeops/agreements/${encodeURIComponent(input.artifactId)}/pins`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.pin;
  },
  async unpin(pinId) {
    const response = await request<{
      pin: Awaited<ReturnType<FamilyOperationsAdapter["unpin"]>>;
    }>(`/api/lifeops/agreements/pins/${encodeURIComponent(pinId)}`, {
      method: "DELETE",
    });
    return response.pin;
  },
  async previewGrant(input) {
    const response = await request<{
      preview: Awaited<ReturnType<FamilyOperationsAdapter["previewGrant"]>>;
    }>("/api/lifeops/agreements/grants/preview", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.preview;
  },
  async issueGrant(input) {
    const response = await request<{
      grant: Awaited<ReturnType<FamilyOperationsAdapter["issueGrant"]>>;
    }>("/api/lifeops/agreements/grants", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.grant;
  },
  async revokeGrant(grantId, reason) {
    const response = await request<{
      grant: Awaited<ReturnType<FamilyOperationsAdapter["revokeGrant"]>>;
    }>(`/api/lifeops/agreements/grants/${encodeURIComponent(grantId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    return response.grant;
  },
  async resolveCalendarConflict(linkId, resolution, expectedUpdatedAt) {
    await request(
      `/api/lifeops/calendar/links/${encodeURIComponent(linkId)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          strategy: resolution,
          expectedUpdatedAt,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  },
  async disconnectCalendar(linkId, expectedUpdatedAt) {
    await request(
      `/api/lifeops/calendar/links/${encodeURIComponent(linkId)}/disconnect`,
      {
        method: "POST",
        body: JSON.stringify({
          retainEvents: true,
          expectedUpdatedAt,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  },
  async runSchoolWorkflow() {
    await request("/api/lifeops/family-workflows/school/run", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  async approveSchoolDiff(runId) {
    await request("/api/lifeops/family-workflows/school/apply", {
      method: "POST",
      body: JSON.stringify({ runId }),
    });
  },
  async generatePacket(_periodKey) {
    await request("/api/lifeops/family-workflows/packets", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
};
