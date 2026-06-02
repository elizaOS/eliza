// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsDocumentsSection } from "./LifeOpsDocumentsSection.js";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const { mockClient, setActionNotice } = vi.hoisted(() => ({
  mockClient: {
    listDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    deleteDocument: vi.fn(),
    getDocument: vi.fn(),
    updateDocument: vi.fn(),
  },
  setActionNotice: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
}));

vi.mock("@elizaos/ui", async () => {
  const React = await import(
    "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
  );

  return {
    client: mockClient,
    useAgentElement: () => ({ ref: vi.fn(), agentProps: {} }),
    useApp: () => ({ setActionNotice }),
    Button: React.forwardRef<
      HTMLButtonElement,
      React.ButtonHTMLAttributes<HTMLButtonElement> & {
        size?: string;
        variant?: string;
      }
    >(function Button({ size: _size, variant: _variant, ...props }, ref) {
      return <button ref={ref} {...props} />;
    }),
    Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
      function Input(props, ref) {
        return <input ref={ref} {...props} />;
      },
    ),
    Textarea: React.forwardRef<
      HTMLTextAreaElement,
      React.TextareaHTMLAttributes<HTMLTextAreaElement>
    >(function Textarea(props, ref) {
      return <textarea ref={ref} {...props} />;
    }),
    PagePanel: ({
      as: Element = "div",
      variant: _variant,
      children,
      ...props
    }: {
      as?: keyof JSX.IntrinsicElements;
      variant?: string;
      children: React.ReactNode;
    }) => <Element {...props}>{children}</Element>,
  };
});

const documentRecord = {
  id: "doc-1",
  filename: "board-notes.txt",
  scope: "owner-private",
  createdAt: 1_755_000_000,
  canEditText: true,
  canDelete: true,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsDocumentsSection", () => {
  it("renders compact empty state and creates an owner-private note", async () => {
    mockClient.listDocuments.mockResolvedValue({ documents: [] });
    mockClient.uploadDocument.mockResolvedValue({ fragmentCount: 1 });

    const { container } = render(<LifeOpsDocumentsSection />);

    await waitFor(() =>
      expect(screen.getByText("No owner-private documents")).toBeTruthy(),
    );
    expect(container.textContent).not.toContain("Loading documents...");
    expect(container.textContent).not.toContain(
      'No owner-private documents yet. Use "New note" to add one.',
    );

    fireEvent.click(screen.getByRole("button", { name: "New document note" }));
    fireEvent.change(screen.getByPlaceholderText("Title (optional)"), {
      target: { value: "Board note" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("What should the agent remember privately?"),
      { target: { value: "Follow up before the board packet closes." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() =>
      expect(mockClient.uploadDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Follow up before the board packet closes.",
          filename: "board-note.txt",
          scope: "owner-private",
        }),
      ),
    );
    expect(setActionNotice).toHaveBeenCalledWith(
      "Saved owner-private document (1 fragment(s)).",
      "success",
      3000,
    );
  });

  it("keeps document row actions icon-only but accessible", async () => {
    mockClient.listDocuments.mockResolvedValue({ documents: [documentRecord] });
    mockClient.getDocument.mockResolvedValue({
      document: { content: { text: "Original private note" } },
    });
    mockClient.updateDocument.mockResolvedValue({});
    mockClient.deleteDocument.mockResolvedValue({});

    const { container } = render(<LifeOpsDocumentsSection />);

    await waitFor(() => expect(screen.getByText("board-notes.txt")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Edit board-notes.txt" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete board-notes.txt" }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain("EditDelete");
    expect(container.textContent).not.toContain("Deleting...");

    fireEvent.click(screen.getByRole("button", { name: "Edit board-notes.txt" }));
    await waitFor(() => expect(mockClient.getDocument).toHaveBeenCalledWith("doc-1"));
    fireEvent.change(screen.getByDisplayValue("Original private note"), {
      target: { value: "Updated private note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save document edit" }));

    await waitFor(() =>
      expect(mockClient.updateDocument).toHaveBeenCalledWith("doc-1", {
        content: "Updated private note",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete board-notes.txt" }));
    await waitFor(() => expect(mockClient.deleteDocument).toHaveBeenCalledWith("doc-1"));
  });
});
