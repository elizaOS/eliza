// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === "string" ? options.defaultValue : _key,
  }),
}));

import { ConversationImportPanel } from "./MemoryViewerView";

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("file input not found");
  }
  return input;
}

beforeEach(() => {
  clientMock.uploadDocument.mockResolvedValue({ documentId: "doc-1" });
  clientMock.deleteDocument.mockResolvedValue({ ok: true });
  clientMock.getDocument.mockResolvedValue({ document: { id: "doc-1" } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clientMock.uploadDocument.mockReset();
  clientMock.deleteDocument.mockReset();
  clientMock.getDocument.mockReset();
});

describe("ConversationImportPanel", () => {
  it("drives source selection, scrubbed preview, consent-gated import, readback, and batch delete", async () => {
    const onImported = vi.fn();
    const { container } = render(
      <ConversationImportPanel onImported={onImported} />,
    );

    fireEvent.change(screen.getByDisplayValue("ChatGPT"), {
      target: { value: "claude" },
    });

    const exportFile = new File(
      [
        JSON.stringify([
          {
            uuid: "conv-1",
            name: "Claude secrets",
            chat_messages: [
              {
                uuid: "msg-1",
                sender: "human",
                text: "hello Bearer sk-live-secret",
                created_at: "2026-07-05T00:00:00Z",
              },
              {
                uuid: "msg-2",
                sender: "assistant",
                text: "stored safely",
                created_at: "2026-07-05T00:00:01Z",
              },
            ],
          },
        ]),
      ],
      "claude.json",
      { type: "application/json" },
    );

    fireEvent.change(fileInput(container), { target: { files: [exportFile] } });

    await waitFor(() => expect(screen.getByText("Messages")).not.toBeNull());
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent?.toLowerCase()).toContain("[redacted]");
    expect(container.textContent).not.toContain("sk-live-secret");

    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByLabelText("Import the scrubbed preview"));
    expect(importButton).toHaveProperty("disabled", false);
    fireEvent.click(importButton);

    await waitFor(() =>
      expect(clientMock.uploadDocument).toHaveBeenCalledTimes(1),
    );
    expect(clientMock.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "claude/conv-1.md",
        contentType: "text/markdown",
        scope: "user-private",
        addedFrom: "import",
        metadata: expect.objectContaining({
          source: "import",
          addedFrom: "import",
          import: expect.objectContaining({
            source: "claude",
            sourceConversationId: "conv-1",
          }),
        }),
      }),
    );
    expect(clientMock.uploadDocument.mock.calls[0][0].content).not.toContain(
      "sk-live-secret",
    );
    await waitFor(() =>
      expect(screen.getByText(/claude · 1\/1/u)).not.toBeNull(),
    );
    expect(screen.getByText(/complete · read back/u)).not.toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Delete batch/u }));
    await waitFor(() =>
      expect(clientMock.deleteDocument).toHaveBeenCalledWith("doc-1"),
    );
    expect(screen.getByText(/deleted/u)).not.toBeNull();
    expect(onImported).toHaveBeenCalledTimes(2);
  });
});
