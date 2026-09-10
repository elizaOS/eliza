/** Synthetic browser state for editing monthly email; no method can call a live provider. */
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
  FamilyPacketView,
} from "../../src/components/family-operations/types.js";

export function createFamilyPacketFixture(
  failRevision: boolean,
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
  return {
    listRecipientContacts: unsupported,
    confirmEmailRecipient: unsupported,
    async load(): Promise<FamilyOperationsSnapshot> {
      return {
        agreements: { status: "ready", data: [] },
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
    },
    uploadAgreement: unsupported,
    decideObligation: unsupported,
    listPins: unsupported,
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
