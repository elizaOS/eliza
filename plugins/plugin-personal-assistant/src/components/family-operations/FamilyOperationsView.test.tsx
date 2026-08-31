// @vitest-environment jsdom

/** Component behavior and accessibility-name coverage for Family Operations. */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
    approveSchoolDiff: vi.fn(async () => undefined),
    generatePacket: vi.fn(async () => undefined),
  } as FamilyOperationsAdapter;
}

describe("FamilyOperationsView", () => {
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
});
