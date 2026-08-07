/** Verifies MediaGalleryView through the package's configured test harness. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  t: (
    _key: string,
    options?: { defaultValue?: string; [key: string]: unknown },
  ) => {
    let value = options?.defaultValue ?? _key;
    for (const [key, replacement] of Object.entries(options ?? {})) {
      value = value.replace(`{{${key}}}`, String(replacement));
    }
    return value;
  },
}));
const clientMock = vi.hoisted(() => ({
  getDatabaseTables: vi.fn(),
  executeDatabaseQuery: vi.fn(),
}));
const transferMock = vi.hoisted(() => ({
  canShareFiles: vi.fn(),
  downloadAttachment: vi.fn(),
  filenameForMime: vi.fn(() => "download"),
  shareAttachment: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appMock) => unknown) =>
    selector(appMock),
}));
vi.mock("../../api", () => ({ client: clientMock }));
vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));
vi.mock("../../utils/download-share", () => transferMock);

import { MediaGalleryView } from "./MediaGalleryView";

beforeEach(() => {
  vi.clearAllMocks();
  transferMock.canShareFiles.mockReturnValue(false);
  transferMock.downloadAttachment.mockResolvedValue(undefined);
  transferMock.shareAttachment.mockResolvedValue(false);
  clientMock.getDatabaseTables.mockResolvedValue({
    tables: [{ name: "memories" }],
  });
  clientMock.executeDatabaseQuery.mockResolvedValue({
    rows: [
      { content: "https://example.test/photo.png", createdAt: "2026-07-17" },
    ],
  });
});

afterEach(cleanup);

describe("MediaGalleryView", () => {
  it("announces a download failure and clears it on a successful retry", async () => {
    transferMock.downloadAttachment
      .mockRejectedValueOnce(new Error("Transport unavailable"))
      .mockResolvedValueOnce(undefined);
    render(<MediaGalleryView />);

    await screen.findByRole("heading", { name: "photo.png" });
    fireEvent.click(screen.getByTestId("media-download"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not download photo.png: Transport unavailable",
    );

    fireEvent.click(screen.getByTestId("media-download"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("marks the scan busy and exposes load failures as alerts", async () => {
    let rejectLoad: (error: Error) => void = () => {};
    clientMock.getDatabaseTables.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLoad = reject;
      }),
    );
    const { container } = render(<MediaGalleryView />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    rejectLoad(new Error("Database unavailable"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Failed to load media: Database unavailable",
    );
    expect(container.querySelector('[aria-busy="false"]')).toBeTruthy();
  });
});
