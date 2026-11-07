// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../../api/client";
import type { StoredFile } from "../../../api/client-files";

vi.mock("../../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));

vi.mock("../../../hooks/useRole", () => ({
  useRole: () => ({ role: "ADMIN" }),
}));

vi.mock("../../../utils/download-share", () => ({
  canShareFiles: () => false,
  downloadAttachment: vi.fn(),
  filenameForMime: () => "file",
  shareAttachment: vi.fn(),
}));

vi.mock("../../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

import { FilesView } from "../FilesView";

function storedFile(fileName: string): StoredFile {
  return {
    url: `/media/${fileName}`,
    hash: `hash-${fileName}`,
    fileName,
    mimeType: "text/plain",
    size: 12,
    createdAt: 1_700_000_000_000,
  };
}

describe("FilesView agent authority switching", () => {
  const originalBaseUrl = client.getBaseUrl();
  const originalListFiles = client.listFiles;

  beforeEach(() => {
    client.setBaseUrl("http://agent-a.invalid");
    client.listFiles = vi.fn(async () => ({
      files: [
        storedFile(
          client.getBaseUrl().includes("agent-a") ? "agent-a.txt" : "agent-b.txt",
        ),
      ],
    }));
  });

  afterEach(() => {
    cleanup();
    client.listFiles = originalListFiles;
    client.setBaseUrl(originalBaseUrl || null);
  });

  it("replaces departed agent rows before the next agent becomes actionable", async () => {
    const mounted = render(<FilesView />);
    expect(await screen.findByText("agent-a.txt")).toBeTruthy();

    act(() => {
      client.setBaseUrl("http://agent-b.invalid");
      mounted.rerender(<FilesView />);
    });

    await waitFor(() => expect(screen.queryByText("agent-a.txt")).toBeNull());
    expect(await screen.findByText("agent-b.txt")).toBeTruthy();
    expect(client.listFiles).toHaveBeenCalledTimes(2);
  });
});
