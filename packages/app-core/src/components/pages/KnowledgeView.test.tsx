// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, useAppMock } = vi.hoisted(() => ({
  clientMock: {
    deleteKnowledgeDocument: vi.fn(),
    getKnowledgeDocument: vi.fn(),
    getKnowledgeFragments: vi.fn(),
    listKnowledgeDocuments: vi.fn(),
    searchKnowledge: vi.fn(),
    updateKnowledgeDocument: vi.fn(),
    uploadKnowledgeDocumentsBulk: vi.fn(),
    uploadKnowledgeFromUrl: vi.fn(),
  },
  useAppMock: vi.fn(),
}));

vi.mock("@elizaos/ui", () => {
  const PagePanel = Object.assign(
    ({ children, className }: { children?: ReactNode; className?: string }) => (
      <section className={className}>{children}</section>
    ),
    {
      Empty: ({
        children,
        description,
        title,
      }: {
        children?: ReactNode;
        description?: ReactNode;
        title?: ReactNode;
      }) => (
        <div>
          <div>{title}</div>
          <div>{description}</div>
          {children}
        </div>
      ),
      Notice: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  );

  return {
    Button: ({
      children,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    Checkbox: ({
      checked,
      id,
      onCheckedChange,
    }: {
      checked?: boolean;
      id?: string;
      onCheckedChange?: (checked: boolean) => void;
    }) => (
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
    ),
    Input: (props: InputHTMLAttributes<HTMLInputElement>) => (
      <input {...props} />
    ),
    PagePanel,
    Textarea: (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea {...props} />
    ),
  };
});

vi.mock("../../api/client", () => ({
  client: clientMock,
}));

vi.mock("../../state", () => ({
  useApp: () => useAppMock(),
}));

vi.mock("../../state/useApp", () => ({
  useApp: () => useAppMock(),
}));

import { KnowledgeView } from "./KnowledgeView";
import { DocumentViewer } from "./knowledge-detail";

function buildUseAppState() {
  return {
    setActionNotice: vi.fn(),
    t: (key: string, options?: Record<string, unknown>) => {
      let value = String(options?.defaultValue ?? key);
      for (const [optionKey, optionValue] of Object.entries(options ?? {})) {
        value = value.replaceAll(`{{${optionKey}}}`, String(optionValue));
      }
      return value;
    },
  };
}

function buildDocument(overrides: Record<string, unknown> = {}) {
  return {
    canDelete: true,
    canEditText: true,
    contentType: "text/markdown",
    createdAt: 1_713_916_800_000,
    fileSize: 1280,
    filename: "guide.md",
    fragmentCount: 2,
    id: "doc-1",
    provenance: { kind: "upload", label: "Upload" },
    source: "upload",
    ...overrides,
  };
}

describe("KnowledgeView", () => {
  beforeEach(() => {
    useAppMock.mockReturnValue(buildUseAppState());
    clientMock.listKnowledgeDocuments.mockResolvedValue({
      documents: [buildDocument()],
      limit: 100,
      offset: 0,
      total: 1,
    });
    clientMock.getKnowledgeDocument.mockResolvedValue({
      document: {
        ...buildDocument(),
        content: { text: "Document preview" },
      },
    });
    clientMock.getKnowledgeFragments.mockResolvedValue({
      count: 2,
      documentId: "doc-1",
      fragments: [
        {
          createdAt: 1_713_916_800_000,
          id: "frag-1",
          position: 0,
          text: "First chunk",
        },
        {
          createdAt: 1_713_916_900_000,
          id: "frag-2",
          position: 1,
          text: "Second chunk",
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps upload, search, document list, and metadata visible in embedded mode", async () => {
    render(<KnowledgeView embedded showSelectorRail={false} />);

    expect(await screen.findByText("guide.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
    expect(
      screen.getByPlaceholderText("knowledge.ui.searchPlaceholder"),
    ).toBeTruthy();
    expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
    expect(screen.getByText("1 doc")).toBeTruthy();
    expect(screen.getByText(/Upload • 2 fragments • 1.3 KB/)).toBeTruthy();
  });

  it("renders fragments as numbered chunks with fragment metadata", async () => {
    render(<DocumentViewer documentId="doc-1" />);

    await waitFor(() => {
      expect(screen.getByText("First chunk")).toBeTruthy();
    });

    expect(screen.getAllByText("Chunk")).toHaveLength(2);
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("position 0")).toBeTruthy();
    expect(screen.getByText("11 chars")).toBeTruthy();
  });
});
