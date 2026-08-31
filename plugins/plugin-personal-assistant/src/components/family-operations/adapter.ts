/** Production Family Operations adapter over owner-authorized local APIs. */

import type { ParentingAgreementView } from "../../lifeops/household/agreement-knowledge.js";
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

export const defaultFamilyOperationsAdapter: FamilyOperationsAdapter = {
  async load(): Promise<FamilyOperationsSnapshot> {
    const [agreements, calendarLinks, school, packets] = await Promise.all([
      loadSection<ParentingAgreementView[]>(
        "/api/lifeops/agreements",
        "agreements",
      ),
      loadSection<LinkedCalendarView[]>("/api/lifeops/calendar/links", "links"),
      loadSection<SchoolWorkflowView>(
        "/api/lifeops/school-calendar/status",
        "workflow",
      ),
      loadSection<FamilyPacketView[]>("/api/lifeops/family-packets", "packets"),
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
    await request("/api/lifeops/school-calendar/run", {
      method: "POST",
      body: JSON.stringify({ triggerKind: "manual" }),
    });
  },
  async approveSchoolDiff(runId) {
    await request(
      `/api/lifeops/school-calendar/runs/${encodeURIComponent(runId)}/approve`,
      { method: "POST", body: JSON.stringify({ approved: true }) },
    );
  },
  async generatePacket(periodKey) {
    await request("/api/lifeops/family-packets/generate", {
      method: "POST",
      body: JSON.stringify({ periodKey }),
    });
  },
};
