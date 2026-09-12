// @vitest-environment jsdom

/** Component behavior and accessibility-name coverage for Family Operations. */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FamilyOperationsAdapter,
  FamilyOperationsSnapshot,
} from "./types.js";

vi.mock("./adapter.js", () => ({ defaultFamilyOperationsAdapter: {} }));

import { FamilyOperationsView } from "./FamilyOperationsView.js";

afterEach(cleanup);

function snapshot(): FamilyOperationsSnapshot {
  return {
    agreements: {
      status: "ready",
      data: [
        {
          artifact: {
            id: "artifact-1",
            agentId: "agent-1",
            householdId: "default",
            agreementKey: "parenting-plan",
            version: 1,
            supersedesArtifactId: null,
            title: "Parenting plan",
            originalFilename: "plan.pdf",
            documentId: "document-1",
            mediaUrl: "/api/media/hash.pdf",
            mediaFileName: "hash.pdf",
            contentSha256: "abcdef0123456789",
            mimeType: "application/pdf",
            byteSize: 2048,
            pageCount: 12,
            uploadedByEntityId: "self",
            createdAt: "2026-08-30T12:00:00.000Z",
          },
          obligations: [
            {
              id: "obligation-1",
              agentId: "agent-1",
              artifactId: "artifact-1",
              title: "School notice",
              obligationText: "Share school notices within 24 hours.",
              pageStart: 4,
              pageEnd: 5,
              citationText: "Each parent shall forward school notices.",
              status: "proposed",
              proposedByEntityId: "agent-1",
              decidedByEntityId: null,
              decisionReason: null,
              decidedAt: null,
              createdAt: "2026-08-30T12:00:00.000Z",
              updatedAt: "2026-08-30T12:00:00.000Z",
            },
          ],
        },
      ],
    },
    calendarLinks: {
      status: "ready",
      data: [
        {
          id: "link-1",
          localEventId: "school-pickup",
          providerCalendarId: "primary",
          state: "conflicted",
          updatedAt: "2026-08-30T12:00:00.000Z",
        },
      ],
    },
    school: { status: "unavailable", message: "School API is not installed." },
    packets: { status: "ready", data: [] },
    emailOptions: {
      status: "ready",
      data: {
        accounts: [{ grantId: "sender-1", label: "owner@example.com" }],
        recipients: [
          { entityId: "guest-1", name: "Alex", address: "guest@example.com" },
        ],
      },
    },
  };
}

function adapter(data = snapshot()): FamilyOperationsAdapter {
  return {
    load: vi.fn(async () => data),
    decideObligation: vi.fn(async (obligation, decision, reason) => ({
      ...obligation,
      status: decision === "approve" ? "approved" : "rejected",
      decisionReason: reason,
    })),
    listPins: vi.fn(async () => []),
    pin: vi.fn(),
    unpin: vi.fn(),
    previewGrant: vi.fn(async () => ({
      allowed: false,
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "grant-1",
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: {
        code: "AGREEMENT_ACCESS_DENIED",
        message: "Identity is not verified.",
      },
    })),
    issueGrant: vi.fn(),
    revokeGrant: vi.fn(),
    resolveCalendarConflict: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined),
    runSchoolWorkflow: vi.fn(async () => undefined),
    configureSchool: vi.fn(async () => undefined),
    approveSchoolDiff: vi.fn(async () => undefined),
    generatePacket: vi.fn(async () => undefined),
    uploadAgreement: vi.fn(async () => undefined),
    downloadAgreement: vi.fn(async () => new Blob()),
    createPacketDraft: vi.fn(async () => undefined),
    revisePacketDraft: vi.fn(async () => undefined),
    requestPacketApproval: vi.fn(async () => undefined),
  } as FamilyOperationsAdapter;
}

describe("FamilyOperationsView", () => {
  it("saves the selected school level and standing update policy before running", async () => {
    const local = adapter();
    const data = await local.load();
    data.school = {
      status: "ready",
      data: {
        sourceId: "concord",
        label: "Concord calendar",
        state: "never_run",
        lastCheckedAt: null,
        sourceUrl:
          "https://www.concordps.org/district-resources/school-year-calendars",
        schoolLevel: "all",
        updateMode: "review",
      },
    };
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "School calendar" }),
    );
    fireEvent.change(screen.getByLabelText("School level"), {
      target: { value: "elementary" },
    });
    fireEvent.change(screen.getByLabelText("Calendar updates"), {
      target: { value: "automatic" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save school settings" }),
    );
    await waitFor(() =>
      expect(local.configureSchool).toHaveBeenCalledWith({
        schoolLevel: "elementary",
        updateMode: "automatic",
      }),
    );
    expect(local.runSchoolWorkflow).not.toHaveBeenCalled();
  });
  it("shows export preparation and recovers visibly when the original cannot be verified", async () => {
    const local = adapter();
    let fail: (reason: Error) => void = () => {
      throw new Error("Download has not started");
    };
    local.downloadAgreement = () =>
      new Promise<Blob>((_resolve, reject) => {
        fail = reject;
      });
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export agreement" }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Preparing export…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fail(new Error("Original failed integrity verification"));
    expect(
      await screen.findByText("Original failed integrity verification"),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Export agreement",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("requires a review reason and delegates approval to the canonical adapter", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    expect(
      await screen.findByRole("heading", { name: "Family Operations" }),
    ).toBeTruthy();
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "Checked against pages 4 and 5." },
    });
    fireEvent.click(approve);
    await waitFor(() =>
      expect(local.decideObligation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "obligation-1" }),
        "approve",
        "Checked against pages 4 and 5.",
      ),
    );
  });

  it("keeps unavailable school APIs visibly distinct from an empty workflow", async () => {
    render(<FamilyOperationsView adapter={adapter()} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "School calendar" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "School API is not installed.",
    );
  });

  it("exposes named conflict controls and never includes an expenses section", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Calendar sync" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Keep Eliza" }));
    await waitFor(() =>
      expect(local.resolveCalendarConflict).toHaveBeenCalledWith(
        "link-1",
        "keep_eliza",
        "2026-08-30T12:00:00.000Z",
      ),
    );
    expect(screen.queryByRole("button", { name: /expenses/i })).toBeNull();
  });

  it("requires an explicit reason before revoking a guest grant", async () => {
    const local = adapter();
    render(<FamilyOperationsView adapter={local} />);
    const revoke = await screen.findByRole("button", { name: "Revoke grant" });
    expect((revoke as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Grant ID"), {
      target: { value: "guest-grant-1" },
    });
    fireEvent.change(screen.getByLabelText("Revocation reason"), {
      target: { value: "Access is no longer needed." },
    });
    fireEvent.click(revoke);
    await waitFor(() =>
      expect(local.revokeGrant).toHaveBeenCalledWith(
        "guest-grant-1",
        "Access is no longer needed.",
      ),
    );
  });

  it("uploads a signed PDF as an immutable agreement version", async () => {
    const local = adapter({
      ...snapshot(),
      agreements: { status: "ready", data: [] },
    });
    render(<FamilyOperationsView adapter={local} />);
    const file = new File(["%PDF-1.7"], "parenting-plan.pdf", {
      type: "application/pdf",
    });
    fireEvent.click(await screen.findByText("Choose a signed PDF"));
    fireEvent.change(screen.getByLabelText("Signed PDF"), {
      target: { files: [file] },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Upload immutable PDF" }),
    );
    await waitFor(() =>
      expect(local.uploadAgreement).toHaveBeenCalledWith(
        expect.objectContaining({
          agreementKey: "parenting-plan",
          title: "Parenting agreement",
          file,
          onProgress: expect.any(Function),
        }),
      ),
    );
  });

  it("allows an agreement above the former 20 MiB ceiling", async () => {
    const local = adapter({
      ...snapshot(),
      agreements: { status: "ready", data: [] },
    });
    render(<FamilyOperationsView adapter={local} />);
    const file = new File(["%PDF-1.7"], "oversized.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(file, "size", {
      value: 20 * 1024 * 1024 + 1,
    });
    fireEvent.click(await screen.findByText("Choose a signed PDF"));
    fireEvent.change(screen.getByLabelText("Signed PDF"), {
      target: { files: [file] },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Upload immutable PDF",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Upload immutable PDF" }),
    );
    await waitFor(() => expect(local.uploadAgreement).toHaveBeenCalled());
  });

  it("creates, reviews, and requests approval for an immutable packet draft", async () => {
    const data = snapshot();
    data.packets = {
      status: "ready",
      data: [
        {
          packetId: "packet/1",
          periodKey: "2026-08",
          version: 1,
          createdAt: "2026-08-30T12:00:00.000Z",
          status: "complete",
          claims: [
            { id: "claim-1", section: "school", text: "No school." },
            {
              id: "private-claim",
              section: "owner",
              text: "Private owner note omitted by the disclosure policy.",
            },
          ],
          draft: {
            draftVersion: 2,
            recipient: "guest@example.com",
            recipientEntityId: "guest-1",
            calendarPrivacyMode: "busy_only",
            body: "Family coordination\n\n## school\n- No school.",
            email: { subject: "Monthly plans", senderGrantId: "sender-1" },
          },
        },
      ],
    };
    const local = adapter(data);
    render(<FamilyOperationsView adapter={local} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Monthly packet" }),
    );
    const download = screen
      .getByRole("link", {
        name: "Download draft record",
      })
      .getAttribute("href");
    if (!download) throw new Error("Draft download has no payload");
    const record = JSON.parse(decodeURIComponent(download.split(",")[1]));
    expect(record.draft.body).toBe(data.packets.data[0].draft?.body);
    expect(JSON.stringify(record)).not.toContain("Private owner note");
    fireEvent.change(screen.getByLabelText("Sending account"), {
      target: { value: "sender-1" },
    });
    fireEvent.change(screen.getByLabelText("Email recipient"), {
      target: { value: JSON.stringify(["guest-1", "guest@example.com"]) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create privacy-filtered draft" }),
    );
    await waitFor(() =>
      expect(local.createPacketDraft).toHaveBeenCalledWith({
        packetId: "packet/1",
        recipient: "guest@example.com",
        recipientEntityId: "guest-1",
        calendarPrivacyMode: "busy_only",
        email: { subject: expect.any(String), senderGrantId: "sender-1" },
      }),
    );
    expect(screen.getByText(/Family coordination/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Request owner approval" }),
    );
    await waitFor(() =>
      expect(local.requestPacketApproval).toHaveBeenCalledWith("packet/1", 2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit email draft" }));
    fireEvent.change(screen.getByLabelText("Email text"), {
      target: { value: "Please confirm pickup at 3 PM." },
    });
    fireEvent.change(
      within(
        screen.getByRole("group", { name: "Edit saved email" }),
      ).getByLabelText("Email subject"),
      {
        target: { value: "Updated monthly plans" },
      },
    );
    expect(
      screen.queryByRole("button", { name: "Request owner approval" }),
    ).toBeNull();
    const saved = data.packets.data[0].draft;
    if (!saved) throw new Error("Fixture omitted saved draft");
    vi.mocked(local.load).mockResolvedValue({
      ...data,
      packets: {
        status: "ready",
        data: [
          {
            ...data.packets.data[0],
            draft: {
              ...saved,
              draftVersion: 3,
              body: "Please confirm pickup at 3 PM.",
              email: {
                subject: "Updated monthly plans",
                senderGrantId: "sender-1",
              },
            },
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new draft" }));
    await waitFor(() =>
      expect(local.revisePacketDraft).toHaveBeenCalledWith({
        packetId: "packet/1",
        expectedDraftVersion: 2,
        subject: "Updated monthly plans",
        body: "Please confirm pickup at 3 PM.",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Request owner approval" }),
    );
    await waitFor(() =>
      expect(local.requestPacketApproval).toHaveBeenLastCalledWith(
        "packet/1",
        3,
      ),
    );
  });
});
