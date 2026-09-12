/** Synthetic agreement, email review, and approval state; no method can call a live provider. */
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  FamilyPacketView,
} from "../../src/components/family-operations/types.js";

export function createFamilyPacketFixture(
  failRevision: boolean,
  uncertainDecision = false,
): FamilyOperationsAdapter {
  let packet: FamilyPacketView = {
    packetId: "fixture-packet",
    periodKey: "2026-10",
    version: 1,
    createdAt: "2026-09-20T12:00:00Z",
    status: "complete",
    sections: [],
    claims: [
      {
        id: "private",
        section: "travel_consent_health",
        text: "Private fixture canary",
      },
    ],
    draft: {
      draftVersion: 1,
      bodySha256: "",
      approval: null,
      recipient: "guest@example.test",
      recipientEntityId: "fixture-guest",
      calendarPrivacyMode: "busy_only",
      body: "Please confirm the October pickup schedule.",
      email: { subject: "October plans", senderGrantId: "fixture-sender" },
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error("This operation is outside the synthetic email fixture.");
  };
  async function digest(body: string): Promise<string> {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    return Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  return {
    async decidePacketApproval(input) {
      const draft = packet.draft;
      if (
        input.packetId !== packet.packetId ||
        !draft?.approval ||
        input.draftVersion !== draft.draftVersion ||
        input.approvalId !== draft.approvalId ||
        input.bodySha256 !== draft.bodySha256
      )
        throw new Error("Fixture decision does not match the reviewed draft.");
      if (draft.approval.state !== "pending")
        throw new Error("Fixture approval already has a decision.");
      document.documentElement.dataset.familyDecision = input.decision;
      if (input.decision === "reject") {
        draft.approval.state = "rejected";
      } else if (uncertainDecision) {
        draft.approval.state = "reconciliation_required";
        draft.approval.error = "Fixture provider outcome is unknown.";
        throw new Error("Check the provider record before retrying.");
      } else {
        draft.approval.state = "done";
        draft.approval.providerAccepted = true;
        draft.approval.providerMessageId = "synthetic-provider-receipt";
      }
    },
    listRecipientContacts: unsupported,
    confirmEmailRecipient: unsupported,
    async load(): Promise<FamilyOperationsSnapshot> {
      if (packet.draft)
        packet.draft.bodySha256 = await digest(packet.draft.body);
      return {
        agreements: {
          status: "ready",
          data: [
            {
              artifact: {
                id: "fixture-agreement",
                agentId: "fixture-agent",
                householdId: "default",
                agreementKey: "synthetic-plan",
                version: 1,
                supersedesArtifactId: null,
                title: "Synthetic parenting plan",
                originalFilename: "synthetic-plan.pdf",
                documentId: "fixture-document",
                mediaUrl: "/api/media/fixture.pdf",
                mediaFileName: "fixture.pdf",
                contentSha256: "a".repeat(64),
                mimeType: "application/pdf",
                byteSize: 2048,
                pageCount: 3,
                uploadedByEntityId: "self",
                createdAt: "2026-09-20T12:00:00Z",
              },
              obligations: [],
            },
          ],
        },
        calendarLinks: { status: "ready", data: [] },
        school: {
          status: "unavailable",
          message: "School source is outside this fixture.",
        },
        packets: { status: "ready", data: [structuredClone(packet)] },
        emailOptions: {
          status: "ready",
          data: {
            accounts: [
              { grantId: "fixture-sender", label: "owner@example.test" },
            ],
            recipients: [
              {
                entityId: "fixture-guest",
                name: "Verified fixture guest",
                address: "guest@example.test",
              },
            ],
          },
        },
      };
    },
    async revisePacketDraft(input) {
      if (failRevision) throw new Error("Fixture revision could not be saved.");
      if (
        !packet.draft?.email ||
        packet.draft.draftVersion !== input.expectedDraftVersion
      )
        throw new Error("Fixture draft is stale.");
      packet = {
        ...packet,
        draft: {
          ...packet.draft,
          draftVersion: packet.draft.draftVersion + 1,
          body: input.body,
          bodySha256: await digest(input.body),
          approval: null,
          email: { ...packet.draft.email, subject: input.subject },
          approvalId: undefined,
        },
      };
    },
    async requestPacketApproval(packetId, version) {
      if (
        packetId !== packet.packetId ||
        packet.draft?.draftVersion !== version
      )
        throw new Error("Fixture approval is stale.");
      document.documentElement.dataset.familyApprovalVersion = String(version);
      packet.draft.approvalId = `fixture-approval-${version}`;
      packet.draft.approval = {
        id: packet.draft.approvalId,
        state: "pending",
        providerAccepted: null,
        providerMessageId: null,
        error: null,
        updatedAt: "2026-09-20T12:01:00Z",
      };
    },
    uploadAgreement: unsupported,
    decideObligation: unsupported,
    async listPins() {
      return [];
    },
    pin: unsupported,
    unpin: unsupported,
    previewGrant: unsupported,
    issueGrant: unsupported,
    revokeGrant: unsupported,
    resolveCalendarConflict: unsupported,
    disconnectCalendar: unsupported,
    runSchoolWorkflow: unsupported,
    configureSchool: unsupported,
    approveSchoolDiff: unsupported,
    generatePacket: unsupported,
    createPacketDraft: unsupported,
  };
}
