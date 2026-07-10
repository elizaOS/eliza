// @vitest-environment jsdom

/**
 * Regression coverage for the document detail (knowledge) viewer load path
 * (#8876). When the detail response lacks a `document`, the viewer must not read
 * `.content` of `undefined` and leak a raw TypeError as the user-facing error;
 * these tests pin the clean degraded message and the happy path.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../../api/client", () => ({
  client: {
    getDocument: (...args: unknown[]) => getDocument(...args),
    getDocumentFragments: (...args: unknown[]) => getDocumentFragments(...args),
    getTranscript: (...args: unknown[]) => getTranscript(...args),
  },
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
});

// Search-to-player deep-link (#14806): a knowledge-search hit's fragment
// startMs opens the transcript reader at the matching audio offset.
describe("DocumentViewer entry seek", () => {
  const transcriptDoc = {
    id: "d1",
    filename: "standup.txt",
    contentType: "text/plain",
    fileSize: 64,
    createdAt: 1_700_000_000_000,
    fragmentCount: 1,
    source: "transcript",
    provenance: { kind: "runtime", label: "Transcript" },
    canEditText: false,
    canDelete: true,
    content: { text: "Alice: hello there" },
    transcriptId: "t-1",
    transcriptAudioUrl: "/api/media/abc.wav",
  };

  it("seeks the word-synced player to initialSeekMs once metadata loads", async () => {
    getDocument.mockResolvedValue({ document: transcriptDoc });
    getTranscript.mockResolvedValue({
      transcript: {
        id: "t-1",
        title: "Standup",
        createdAt: 0,
        durationMs: 90_000,
        source: "voice-session",
        scope: "owner-private",
        status: "ready",
        speakerCount: 1,
        audioUrl: "/api/media/abc.wav",
        segments: [
          {
            id: "s1",
            speakerLabel: "Alice",
            startMs: 61_000,
            endMs: 62_500,
            text: "hello there",
            words: [],
          },
        ],
      },
    });
    render(<DocumentViewer documentId="d1" initialSeekMs={61_000} />);
    await waitFor(() =>
      expect(screen.getByTestId("transcript-scrub")).toBeTruthy(),
    );
    const audio = document.querySelector("audio") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", {
      configurable: true,
      value: 90,
    });
    audio.dispatchEvent(new Event("durationchange"));
    await waitFor(() => expect(audio.currentTime).toBeCloseTo(61, 3));
  });

  it("carries the entry offset into the plain-audio fallback as a media fragment", async () => {
    getDocument.mockResolvedValue({ document: transcriptDoc });
    // No rich record in the transcript store — the reader degrades to the
    // plain <audio> fallback, which encodes the offset as a #t= fragment.
    getTranscript.mockRejectedValue(new Error("transcript store unavailable"));
    render(<DocumentViewer documentId="d1" initialSeekMs={61_000} />);
    await waitFor(() =>
      expect(screen.getByTestId("reader-audio")).toBeTruthy(),
    );
    expect(screen.getByTestId("reader-audio").getAttribute("src")).toMatch(
      /#t=61\.000$/,
    );
  });

  it("does not append a media fragment without an entry offset", async () => {
    getDocument.mockResolvedValue({ document: transcriptDoc });
    getTranscript.mockRejectedValue(new Error("transcript store unavailable"));
    render(<DocumentViewer documentId="d1" />);
    await waitFor(() =>
      expect(screen.getByTestId("reader-audio")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("reader-audio").getAttribute("src"),
    ).not.toContain("#t=");
  });
});
