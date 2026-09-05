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

  it("preserves complete enumeration — scans every candidate table beyond tenth", async () => {
    const tableNames = Array.from({ length: 12 }, (_, i) => `memories_${i}`);
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: tableNames.map((name) => ({ name })),
    });
    clientMock.executeDatabaseQuery.mockImplementation(async (sql: string) => {
      const match = String(sql).match(/FROM "([^"]+)"/);
      const table = match?.[1] ?? "unknown";
      const idx = tableNames.indexOf(table);
      return {
        rows: [
          {
            content: `https://example.test/photo${idx}.png`,
            createdAt: `2026-07-17T0${String(idx).padStart(2, "0")}:00:00.000Z`,
          },
        ],
      };
    });

    render(<MediaGalleryView />);

    // The bug truncated to 10 tables; photo10/photo11 would never appear.
    // All 12 tables must be queried — assert absence of the cap.
    await waitFor(() =>
      expect(clientMock.executeDatabaseQuery).toHaveBeenCalledTimes(12),
    );
    const calledTables = clientMock.executeDatabaseQuery.mock.calls.map(
      ([sql]) => String(sql).match(/FROM "([^"]+)"/)?.[1],
    );
    expect(calledTables).toEqual(
      expect.arrayContaining(["memories_10", "memories_11"]),
    );

    // Gallery renders the full set, not a truncated preview. Sidebar list + count reflect 12.
    await screen.findByText("12 items");
    expect(screen.getAllByText("photo0.png").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("photo10.png").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("photo11.png").length).toBeGreaterThanOrEqual(1);

    // Detail heading shows the most-recent (sorted desc) item — must be photo11, proving it was enumerated.
    expect(
      await screen.findByRole("heading", { name: "photo11.png" }),
    ).toBeTruthy();
  });
});
