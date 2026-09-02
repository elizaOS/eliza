/** Production Family Operations adapter over owner-authorized local APIs. */

import type {
  MonthlyFamilyDraft,
  MonthlyFamilyPacket,
} from "../../lifeops/family-coordination/index.js";
import type { ParentingAgreementView } from "../../lifeops/household/agreement-knowledge.js";
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

interface PacketPersistenceState {
  packetId: string;
  draft: MonthlyFamilyDraft | null;
  approvalId: string | null;
}

interface AgreementUploadState {
  uploadId: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  chunkCount: number;
  receivedChunks: Array<{ index: number; size: number; sha256: string }>;
  receivedBytes: number;
  status: "uploading" | "committing" | "complete";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function agreementContentIdentity(input: {
  sizeBytes: number;
  chunkSizeBytes: number;
  chunks: Array<{ index: number; size: number; sha256: string }>;
}): Promise<string> {
  const canonical = [
    "agreement-upload-content-v1",
    String(input.sizeBytes),
    String(input.chunkSizeBytes),
    ...[...input.chunks]
      .sort((left, right) => left.index - right.index)
      .map((chunk) => `${chunk.index}:${chunk.size}:${chunk.sha256}`),
  ].join("\n");
  return sha256Hex(new TextEncoder().encode(canonical).buffer);
}

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
    changes: review?.plan?.changes.flatMap((change) =>
      change.kind === "unchanged"
        ? []
        : [
            {
              kind: change.kind === "cancel" ? "remove" : change.kind,
              label: change.event.title,
            },
          ],
    ),
    error: review?.errorMessage ?? undefined,
  };
}

function packetView(
  packet: MonthlyFamilyPacket,
  persistence?: PacketPersistenceState,
): FamilyPacketView {
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
    draft: persistence?.draft
      ? {
          draftVersion: persistence.draft.draftVersion,
          recipient: persistence.draft.recipient,
          recipientEntityId: persistence.draft.recipientEntityId,
          calendarPrivacyMode: persistence.draft.calendarPrivacyMode,
          body: persistence.draft.body,
          approvalId: persistence.approvalId ?? undefined,
        }
      : null,
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
    const payload = await request<{
      packets: MonthlyFamilyPacket[];
      packetStates?: PacketPersistenceState[];
    }>("/api/lifeops/family-workflows/packets");
    const states = new Map(
      (payload.packetStates ?? []).map((state) => [state.packetId, state]),
    );
    return {
      status: "ready",
      data: payload.packets.map((packet) =>
        packetView(packet, states.get(packet.packetId)),
      ),
    };
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
  async uploadAgreement(input) {
    if (input.file.type !== "application/pdf") {
      throw new Error("Agreement must be a PDF.");
    }
    if (input.file.size < 1) {
      throw new Error("Agreement PDF must not be empty.");
    }
    const signature = new Uint8Array(
      await input.file.slice(0, 5).arrayBuffer(),
    );
    if (new TextDecoder("ascii").decode(signature) !== "%PDF-") {
      throw new Error("Agreement PDF signature is invalid.");
    }

    const resumeKey = `lifeops:agreement-upload:${input.file.name}:${input.file.size}:${input.file.lastModified}:${input.agreementKey}:${input.title}`;
    let upload: AgreementUploadState | null = null;
    const savedUploadId = sessionStorage.getItem(resumeKey);
    if (savedUploadId) {
      try {
        const response = await request<{ upload: AgreementUploadState }>(
          `/api/lifeops/agreement-uploads/${encodeURIComponent(savedUploadId)}`,
        );
        upload = response.upload;
      } catch {
        sessionStorage.removeItem(resumeKey);
      }
    }
    if (!upload) {
      const response = await request<{ upload: AgreementUploadState }>(
        "/api/lifeops/agreement-uploads",
        {
          method: "POST",
          body: JSON.stringify({
            agreementKey: input.agreementKey,
            title: input.title,
            originalFilename: input.file.name,
            mimeType: input.file.type,
            sizeBytes: input.file.size,
          }),
        },
      );
      upload = response.upload;
      sessionStorage.setItem(resumeKey, upload.uploadId);
    }

    if (upload.status === "complete") {
      sessionStorage.removeItem(resumeKey);
      return;
    }

    const received = new Map(
      upload.receivedChunks.map((chunk) => [chunk.index, chunk]),
    );
    const verifiedChunks: Array<{
      index: number;
      size: number;
      sha256: string;
    }> = [];
    let uploadedBytes = 0;
    input.onProgress?.({
      uploadedBytes,
      totalBytes: input.file.size,
      phase: "uploading",
    });
    for (let index = 0; index < upload.chunkCount; index += 1) {
      const start = index * upload.chunkSizeBytes;
      const end = Math.min(start + upload.chunkSizeBytes, input.file.size);
      const bytes = await input.file.slice(start, end).arrayBuffer();
      const sha256 = await sha256Hex(bytes);
      const recorded = received.get(index);
      if (recorded) {
        if (recorded.size !== bytes.byteLength || recorded.sha256 !== sha256) {
          sessionStorage.removeItem(resumeKey);
          throw new Error(
            "The selected PDF no longer matches the resumable upload. Retry to start a new verified upload.",
          );
        }
      } else {
        await request<{ upload: AgreementUploadState }>(
          `/api/lifeops/agreement-uploads/${encodeURIComponent(upload.uploadId)}/chunks/${index}`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/octet-stream",
              "x-chunk-sha256": sha256,
            },
            body: bytes,
          },
        );
      }
      verifiedChunks.push({ index, size: bytes.byteLength, sha256 });
      uploadedBytes += bytes.byteLength;
      input.onProgress?.({
        uploadedBytes,
        totalBytes: input.file.size,
        phase: "uploading",
      });
    }
    input.onProgress?.({
      uploadedBytes: input.file.size,
      totalBytes: input.file.size,
      phase: "processing",
    });
    const contentIdentity = await agreementContentIdentity({
      sizeBytes: input.file.size,
      chunkSizeBytes: upload.chunkSizeBytes,
      chunks: verifiedChunks,
    });
    await request(
      `/api/lifeops/agreement-uploads/${encodeURIComponent(upload.uploadId)}/commit`,
      { method: "POST", body: JSON.stringify({ contentIdentity }) },
    );
    sessionStorage.removeItem(resumeKey);
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
  async createPacketDraft(input) {
    await request(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(input.packetId)}/drafts`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient: input.recipient,
          recipientEntityId: input.recipientEntityId,
          calendarPrivacyMode: input.calendarPrivacyMode,
        }),
      },
    );
  },
  async requestPacketApproval(packetId, draftVersion) {
    await request(
      `/api/lifeops/family-workflows/packets/${encodeURIComponent(packetId)}/drafts/${draftVersion}/approval`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
};
