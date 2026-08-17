/** Verifies DocumentViewer detail load through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the document detail (knowledge) viewer load path
 * (#8876). When the detail response lacks a `document`, the viewer must not read
 * `.content` of `undefined` and leak a raw TypeError as the user-facing error;
 * these tests pin the clean degraded message and the happy path.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

const getDocument = vi.fn();
const getDocumentFragments = vi.fn();
const getTranscript = vi.fn();
const updateTranscriptPrivacy = vi.fn();
const deleteTranscriptSourceAudio = vi.fn();
vi.mock("../../api/client", () => ({
  client: {
    getDocument: (...args: unknown[]) => getDocument(...args),
    getDocumentFragments: (...args: unknown[]) => getDocumentFragments(...args),
    getTranscript: (...args: unknown[]) => getTranscript(...args),
    updateTranscriptPrivacy: (...args: unknown[]) =>
      updateTranscriptPrivacy(...args),
    deleteTranscriptSourceAudio: (...args: unknown[]) =>
      deleteTranscriptSourceAudio(...args),
  },
}));

const confirmDesktopAction = vi.fn();
vi.mock("../../utils/desktop-dialogs", () => ({
  confirmDesktopAction: (...args: unknown[]) => confirmDesktopAction(...args),
}));

import { DocumentViewer } from "./documents-detail";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

beforeEach(() => {
  appMock.value = { t, setActionNotice: vi.fn() };
  getDocument.mockReset();
  getDocumentFragments.mockReset();
  getTranscript.mockReset();
  updateTranscriptPrivacy.mockReset();
  deleteTranscriptSourceAudio.mockReset();
  confirmDesktopAction.mockReset();
  confirmDesktopAction.mockResolvedValue(true);
  getDocumentFragments.mockResolvedValue({
    documentId: "d1",
    fragments: [],
    count: 0,
  });
});

afterEach(() => cleanup());

describe("DocumentViewer detail load", () => {
  it("shows a clean message (not a raw TypeError) when the detail body has no document", async () => {
    getDocument.mockResolvedValue({});
    render(<DocumentViewer documentId="d1" />);
    await waitFor(() =>
      expect(screen.getByText(/no longer available/i)).toBeTruthy(),
    );
    expect(document.body.textContent ?? "").not.toContain(
      "Cannot read properties of undefined",
    );
  });

  it("renders the document when the detail response is well-formed", async () => {
    getDocument.mockResolvedValue({
      document: {
        id: "d1",
        filename: "q3-strategy.pdf",
        contentType: "application/pdf",
        fileSize: 1024,
        createdAt: 1_700_000_000_000,
        fragmentCount: 0,
        source: "upload",
        provenance: { kind: "upload", label: "Uploaded file" },
        canEditText: false,
        canDelete: true,
        content: { text: "Q3 strategy notes" },
      },
    });
    render(<DocumentViewer documentId="d1" />);
    await waitFor(() =>
      expect(screen.getByText("q3-strategy.pdf")).toBeTruthy(),
    );
  });

  it("sandboxes the PDF reader iframe (same posture as the chat PdfTile)", async () => {
    getDocument.mockResolvedValue({
      document: {
        id: "d1",
        filename: "q3-strategy.pdf",
        contentType: "application/pdf",
        url: `/api/media/${"b".repeat(64)}.pdf`,
        fileSize: 1024,
        createdAt: 1_700_000_000_000,
        fragmentCount: 0,
        source: "upload",
        provenance: { kind: "upload", label: "Uploaded file" },
        canEditText: false,
        canDelete: true,
        content: { text: "Q3 strategy notes" },
      },
    });
    render(<DocumentViewer documentId="d1" />);
    await waitFor(() => expect(screen.getByTestId("reader-pdf")).toBeTruthy());
    // Same-origin so the native viewer's resources load, but no script,
    // forms, popups, or top navigation for the served bytes.
    expect(screen.getByTestId("reader-pdf").getAttribute("sandbox")).toBe(
      "allow-same-origin",
    );
  });

  it("manages retained meeting artifacts from the routed Knowledge reader", async () => {
    const meetingTranscript = {
      id: "t1",
      title: "Planning call",
      createdAt: 1_700_000_000_000,
      durationMs: 12_000,
      audioUrl: `/api/media/${"a".repeat(64)}.wav`,
      audioContentType: "audio/wav",
      source: "meeting",
      scope: "owner-private",
      status: "ready",
      speakerCount: 1,
      segments: [],
      metadata: {
        retention: { state: "audio_retained", sourceAudioDeleted: false },
        sharing: {
          transcript: "owner_private",
          notes: "restricted",
          sourceAudio: "owner_private",
          artifacts: "disabled",
        },
      },
    };
    getDocument.mockResolvedValue({
      document: {
        id: "d1",
        filename: "planning-call.transcript",
        contentType: "text/plain",
        fileSize: 0,
        createdAt: meetingTranscript.createdAt,
        fragmentCount: 0,
        source: "meeting",
        provenance: { kind: "meeting", label: "Meeting transcript" },
        canEditText: false,
        canDelete: true,
        transcriptId: meetingTranscript.id,
        transcriptAudioUrl: meetingTranscript.audioUrl,
        content: { text: "Planning call" },
      },
    });
    getTranscript.mockResolvedValue({ transcript: meetingTranscript });
    deleteTranscriptSourceAudio.mockResolvedValue({
      deleted: true,
      transcript: {
        ...meetingTranscript,
        audioUrl: undefined,
        metadata: {
          ...meetingTranscript.metadata,
          retention: {
            state: "audio_deleted_transcript_retained",
            sourceAudioDeleted: true,
          },
        },
      },
    });

    render(<DocumentViewer documentId="d1" />);
    await waitFor(() =>
      expect(
        screen.getByTestId("transcript-artifact-privacy-controls"),
      ).toBeTruthy(),
    );
    expect(document.querySelector("audio")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete source audio" }),
    );
    await waitFor(() =>
      expect(deleteTranscriptSourceAudio).toHaveBeenCalledWith("t1"),
    );
    expect(confirmDesktopAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Audio deleted, transcript retained")).toBeTruthy();
    expect(document.querySelector("audio")).toBeNull();
  });
});
