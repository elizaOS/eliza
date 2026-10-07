/** Verifies MediaGalleryView through the package's configured test harness. */
// @vitest-environment jsdom

import {
  act,
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
  onAuthorityChange: vi.fn((_listener: () => void) => () => {}),
  getAuthorityRevision: vi.fn(() => 0),
  getDatabaseTables: vi.fn(),
  getDatabaseRows: vi.fn(),
}));
const transferMock = vi.hoisted(() => ({
  canShareFiles: vi.fn(),
  downloadAttachment: vi.fn(),
  filenameForMime: vi.fn(() => "download"),
  shareAttachment: vi.fn(),
}));

vi.mock("../../state/app-store", () => ({
  useAppSelector: (selector: (state: typeof appMock) => unknown) =>
    selector(appMock),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));
vi.mock("../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));
vi.mock("../../utils/download-share", () => transferMock);

import { MediaGalleryView } from "./MediaGalleryView";

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getAuthorityRevision.mockReturnValue(0);
  transferMock.canShareFiles.mockReturnValue(false);
  transferMock.downloadAttachment.mockResolvedValue(undefined);
  transferMock.shareAttachment.mockResolvedValue(false);
  clientMock.getDatabaseTables.mockResolvedValue({
    tables: [{ name: "memories" }],
  });
  clientMock.getDatabaseRows.mockResolvedValue({
    table: "memories",
    rows: [
      { content: "https://example.test/photo.png", createdAt: "2026-07-17" },
    ],
    columns: ["content", "createdAt"],
    total: 1,
    offset: 0,
    limit: 500,
  });
});

afterEach(cleanup);

describe("MediaGalleryView", () => {
  it("includes media from candidate tables after the first batch", async () => {
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: Array.from({ length: 11 }, (_, index) => ({
        name: `media_${index}`,
      })),
    });
    clientMock.getDatabaseRows.mockImplementation(async (tableName: string) => {
      return {
        table: tableName,
        rows: [
          {
            content: `https://example.test/${tableName}.png`,
            createdAt: "2026-10-06",
          },
        ],
        columns: ["content", "createdAt"],
        total: 1,
        offset: 0,
        limit: 500,
      };
    });

    render(<MediaGalleryView />);

    expect(await screen.findByText("media_10.png")).toBeTruthy();
    expect(screen.getByText("11 items")).toBeTruthy();
  });

  it("includes media stored after the first 500 rows", async () => {
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        {
          name: "memories",
          columns: [{ name: "id", isPrimaryKey: true }],
        },
      ],
    });
    clientMock.getDatabaseRows
      .mockResolvedValueOnce({
        table: "memories",
        rows: Array.from({ length: 500 }, (_, index) => ({
          content: `plain text ${index}`,
        })),
        columns: ["content"],
        total: 501,
        offset: 0,
        limit: 500,
      })
      .mockResolvedValueOnce({
        table: "memories",
        rows: [
          {
            content: "https://example.test/after-first-page.png",
            createdAt: "2026-10-06",
          },
        ],
        columns: ["content", "createdAt"],
        total: 501,
        offset: 500,
        limit: 500,
      });

    render(<MediaGalleryView />);

    await screen.findByRole("heading", { name: "after-first-page.png" });
    expect(clientMock.getDatabaseRows).toHaveBeenNthCalledWith(1, "memories", {
      offset: 0,
      limit: 500,
      sort: "id",
      order: "asc",
    });
    expect(clientMock.getDatabaseRows).toHaveBeenNthCalledWith(2, "memories", {
      offset: 500,
      limit: 500,
      sort: "id",
      order: "asc",
    });
  });

  it("does not sort a composite primary key by its first column only", async () => {
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [
        {
          name: "memories",
          columns: [
            { name: "room_id", isPrimaryKey: true },
            { name: "id", isPrimaryKey: true },
          ],
        },
      ],
    });
    clientMock.getDatabaseRows.mockResolvedValue({
      table: "memories",
      rows: [
        {
          content: "https://example.test/composite.png",
          createdAt: "2026-10-06",
        },
      ],
      columns: ["content", "createdAt"],
      total: 1,
      offset: 0,
      limit: 500,
    });

    render(<MediaGalleryView />);

    await screen.findByRole("heading", { name: "composite.png" });
    expect(clientMock.getDatabaseRows).toHaveBeenCalledWith("memories", {
      offset: 0,
      limit: 500,
    });
  });

  it("keeps media from readable tables when another table scan fails", async () => {
    clientMock.getDatabaseTables.mockResolvedValue({
      tables: [{ name: "memories" }, { name: "attachments" }],
    });
    clientMock.getDatabaseRows.mockImplementation(async (tableName: string) => {
      if (tableName === "attachments") {
        throw new Error("attachments unavailable");
      }
      return {
        table: tableName,
        rows: [
          {
            content: "https://example.test/kept.png",
            createdAt: "2026-10-06",
          },
        ],
        columns: ["content", "createdAt"],
        total: 1,
        offset: 0,
        limit: 500,
      };
    });

    render(<MediaGalleryView />);

    expect(
      await screen.findByRole("heading", { name: "kept.png" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("attachments");
  });

  it("keeps earlier pages visible and retries a failed later page", async () => {
    const first = {
      table: "memories",
      rows: [{ content: "https://example.test/kept.png" }],
      columns: ["content"],
      total: 2,
      offset: 0,
      limit: 500,
    };
    const second = {
      ...first,
      rows: [{ content: "https://example.test/later.png" }],
      offset: 1,
    };
    clientMock.getDatabaseRows
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error("page unavailable"))
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    render(<MediaGalleryView />);
    await screen.findByRole("heading", { name: "kept.png" });
    expect(screen.getByRole("alert").textContent).toContain("Retry the scan");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("later.png");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["empty", "invalid-offset"])(
    "announces an incomplete %s page",
    async (kind) => {
      clientMock.getDatabaseRows.mockResolvedValue({
        rows: [],
        total: 1,
        offset: kind === "empty" ? 0 : 5,
      });
      render(<MediaGalleryView />);
      expect((await screen.findByRole("alert")).textContent).toMatch(
        /Retry the scan/,
      );
    },
  );

  it("stops dispatching pages after unmount", async () => {
    let resolvePage!: (value: unknown) => void;
    clientMock.getDatabaseRows.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    const mounted = render(<MediaGalleryView />);
    await waitFor(() =>
      expect(clientMock.getDatabaseRows).toHaveBeenCalledOnce(),
    );
    mounted.unmount();
    await act(async () =>
      resolvePage({
        rows: [{ content: "https://example.test/stale.png" }],
        offset: 0,
        total: 2,
      }),
    );
    expect(clientMock.getDatabaseRows).toHaveBeenCalledOnce();
  });

  it("fences an old page when same-host account authority changes", async () => {
    let resolveOld!: (value: unknown) => void;
    clientMock.getDatabaseRows.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    render(<MediaGalleryView />);
    await waitFor(() =>
      expect(clientMock.getDatabaseRows).toHaveBeenCalledOnce(),
    );
    const refresh = clientMock.onAuthorityChange.mock
      .calls[0]?.[0] as unknown as () => void;
    clientMock.getAuthorityRevision.mockReturnValue(1);
    await act(async () => refresh());
    await screen.findByRole("heading", { name: "photo.png" });
    await act(async () =>
      resolveOld({
        rows: [{ content: "https://example.test/stale.png" }],
        offset: 0,
        total: 2,
      }),
    );
    expect(clientMock.getDatabaseRows).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("stale.png")).toBeNull();
  });

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
