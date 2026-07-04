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
vi.mock("../../api/client", () => ({
  client: {
    getDocument: (...args: unknown[]) => getDocument(...args),
    getDocumentFragments: (...args: unknown[]) => getDocumentFragments(...args),
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
