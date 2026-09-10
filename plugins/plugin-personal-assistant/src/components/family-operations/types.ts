/** View contracts for the owner-facing Family Operations workspace. */

import type {
  FamilyPacketEmailDelivery,
  FamilyPacketSection,
  FamilyPacketSectionSummary,
} from "../../lifeops/family-coordination/index.js";
import type { FamilyEmailOptions } from "../../lifeops/family-workflows/runtime.js";
import type {
  AgreementGuestGrantPreview,
  HouseholdKnowledgeGrant,
  HouseholdKnowledgePin,
  ParentingAgreementObligation,
  ParentingAgreementView,
} from "../../lifeops/household/agreement-knowledge.js";

export type Loadable<T> =
  | { status: "ready"; data: T }
  | { status: "unavailable"; message: string };

export interface LinkedCalendarView {
  id: string;
  localEventId: string;
  providerCalendarId: string;
  state: "clean" | "dirty" | "conflicted" | "quarantined" | "paused";
  updatedAt: string;
  conflict?: { localSummary?: string; providerSummary?: string } | null;
}

export interface SchoolWorkflowView {
  sourceId: string;
  label: string;
  state:
    | "never_run"
    | "running"
    | "unchanged"
    | "awaiting_approval"
    | "applied"
    | "failed";
  lastCheckedAt: string | null;
  sourceUrl: string;
  schoolLevel: "all" | "elementary";
  updateMode: "review" | "automatic";
  runId?: string;
  changes?: Array<{ kind: "add" | "update" | "remove"; label: string }>;
  error?: string;
}

export interface FamilyPacketView {
  packetId: string;
  periodKey: string;
  version: number;
  createdAt: string;
  status: "complete" | "missing" | "contradictory";
  sections: readonly FamilyPacketSectionSummary[];
  claims: Array<{ id: string; section: FamilyPacketSection; text: string }>;
  draft?: {
    draftVersion: number;
    recipient: string;
    recipientEntityId: string;
    calendarPrivacyMode: "full" | "times_only" | "busy_only";
    body: string;
    approvalId?: string;
    email: FamilyPacketEmailDelivery | null;
  } | null;
}

export interface AgreementUploadInput {
  agreementKey: string;
  title: string;
  file: File;
  onProgress?: (progress: {
    uploadedBytes: number;
    totalBytes: number;
    phase: "uploading" | "processing";
  }) => void;
}

export interface PacketDraftInput {
  packetId: string;
  recipient: string;
  recipientEntityId: string;
  calendarPrivacyMode: "full" | "times_only" | "busy_only";
  email?: FamilyPacketEmailDelivery;
}

export interface FamilyOperationsSnapshot {
  agreements: Loadable<ParentingAgreementView[]>;
  calendarLinks: Loadable<LinkedCalendarView[]>;
  school: Loadable<SchoolWorkflowView>;
  packets: Loadable<FamilyPacketView[]>;
  emailOptions: Loadable<FamilyEmailOptions>;
}

export interface FamilyOperationsAdapter {
  load(): Promise<FamilyOperationsSnapshot>;
  uploadAgreement(input: AgreementUploadInput): Promise<void>;
  decideObligation(
    obligation: ParentingAgreementObligation,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<ParentingAgreementObligation>;
  listPins(artifactId: string): Promise<HouseholdKnowledgePin[]>;
  pin(input: {
    artifactId: string;
    targetType: "agent" | "chat";
    targetId: string;
  }): Promise<HouseholdKnowledgePin>;
  unpin(pinId: string): Promise<HouseholdKnowledgePin>;
  previewGrant(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
  }): Promise<AgreementGuestGrantPreview>;
  issueGrant(input: {
    artifactId: string;
    principalEntityId: string;
    householdGrantId: string;
  }): Promise<HouseholdKnowledgeGrant>;
  revokeGrant(
    grantId: string,
    reason: string,
  ): Promise<HouseholdKnowledgeGrant>;
  resolveCalendarConflict(
    linkId: string,
    resolution: "keep_eliza" | "keep_google",
    expectedUpdatedAt: string,
  ): Promise<void>;
  disconnectCalendar(linkId: string, expectedUpdatedAt: string): Promise<void>;
  runSchoolWorkflow(): Promise<void>;
  configureSchool(input: {
    schoolLevel: "all" | "elementary";
    updateMode: "review" | "automatic";
  }): Promise<void>;
  approveSchoolDiff(runId: string): Promise<void>;
  generatePacket(periodKey: string): Promise<void>;
  createPacketDraft(input: PacketDraftInput): Promise<void>;
  revisePacketDraft(input: {
    packetId: string;
    expectedDraftVersion: number;
    body: string;
    subject: string;
  }): Promise<void>;
  requestPacketApproval(packetId: string, draftVersion: number): Promise<void>;
}
