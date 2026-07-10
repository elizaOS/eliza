// @vitest-environment jsdom

/**
 * Search-to-player deep-link coverage for the Knowledge hub (#14806). Drives
 * the REAL DocumentsView flow end to end in jsdom: a knowledge search whose
 * hits carry transcript time anchors renders an anchor badge, and opening an
 * anchored hit mounts the reader with the fragment's startMs as the entry
 * offset (asserted through the plain-audio fallback's `#t=` media fragment —
 * the same `initialSeekMs` that drives the word-synced player seek, covered in
 * TranscriptPlayer.test.tsx / documents-detail.test.tsx). Only the HTTP client
 * and app-state singletons are mocked.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const clientMock = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  searchDocuments: vi.fn(),
  getDocumentFacetCounts: vi.fn(),
  getDocument: vi.fn(),
  getDocumentFragments: vi.fn(),
  getTranscript: vi.fn(),
}));
const chatBinding = vi.hoisted(() => ({
  value: null as null | { onQuery: (value: string) => void },
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useTranslation: () => ({ t: appMock.value.t }),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state/view-chat-binding", () => ({
  // Capture the live binding so the test can feed search queries the same way
  // the floating composer does.
  useRegisterViewChatBinding: (binding: {
    onQuery: (value: string) => void;
  }) => {
    chatBinding.value = binding;
  },
}));
vi.mock("../../utils/desktop-dialogs", () => ({
  confirmDesktopAction: vi.fn(async () => true),
}));

import { DocumentsView } from "./DocumentsView";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

const TRANSCRIPT_DOC = {
  id: "doc-t",
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

beforeEach(() => {
  appMock.value = { t, setActionNotice: vi.fn() };
  chatBinding.value = null;
  for (const fn of Object.values(clientMock)) fn.mockReset();
  clientMock.listDocuments.mockResolvedValue({ documents: [] });
  clientMock.getDocumentFacetCounts.mockResolvedValue({
    counts: { all: 0, doc: 0, image: 0, audio: 0, video: 0, transcript: 0 },
  });
  clientMock.searchDocuments.mockResolvedValue({
    query: "hello",
    threshold: 0.3,
    count: 2,
    results: [
      {
        id: "frag-anchored",
        text: "Alice: hello there",
        similarity: 0.91,
        documentId: "doc-t",
        documentTitle: "standup",
        position: 0,
        transcriptId: "t-1",
        startMs: 61_000,
        endMs: 62_500,
      },
      {
        id: "frag-plain",
        text: "plain document chunk",
        similarity: 0.8,
        documentId: "doc-t",
        documentTitle: "notes",
        position: 3,
      },
    ],
  });
  clientMock.getDocument.mockResolvedValue({ document: TRANSCRIPT_DOC });
  clientMock.getDocumentFragments.mockResolvedValue({
    documentId: "doc-t",
    fragments: [],
    count: 0,
  });
  // No rich record → the reader degrades to the plain-audio fallback, whose
  // src carries the entry offset as a #t= media fragment (the assertable
  // surface for the seek pass-through).
  clientMock.getTranscript.mockRejectedValue(new Error("store unavailable"));
});

afterEach(() => cleanup());

async function searchAndGetResults() {
  render(<DocumentsView />);
  await waitFor(() => expect(chatBinding.value).not.toBeNull());
  act(() => chatBinding.value?.onQuery("hello"));
  // 200 ms debounce before handleSearch fires.
  await waitFor(() =>
    expect(clientMock.searchDocuments).toHaveBeenCalledTimes(1),
  );
  await waitFor(() => expect(screen.getByText("standup")).toBeTruthy());
}

describe("Knowledge search → player deep-link (#14806)", () => {
  it("renders a time-anchor badge only on transcript-fragment hits", async () => {
    await searchAndGetResults();
    expect(screen.getByTestId("result-anchor-frag-anchored").textContent).toBe(
      "1:01–1:02",
    );
    expect(screen.queryByTestId("result-anchor-frag-plain")).toBeNull();
  });

  it("opens an anchored hit with the fragment startMs as the entry offset", async () => {
    await searchAndGetResults();
    fireEvent.click(screen.getByText("standup"));
    await waitFor(() =>
      expect(screen.getByTestId("reader-audio")).toBeTruthy(),
    );
    expect(screen.getByTestId("reader-audio").getAttribute("src")).toMatch(
      /#t=61\.000$/,
    );
  });

  it("opens a plain hit with no entry offset", async () => {
    await searchAndGetResults();
    fireEvent.click(screen.getByText("notes"));
    await waitFor(() =>
      expect(screen.getByTestId("reader-audio")).toBeTruthy(),
    );
    expect(
      screen.getByTestId("reader-audio").getAttribute("src"),
    ).not.toContain("#t=");
  });
});
