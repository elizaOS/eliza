// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFile } from "../../api";
import { getViewChatBinding } from "../../state/view-chat-binding";
import { FilesView } from "./FilesView";

// FilesView talks to the runtime exclusively through the `client` singleton
// re-exported from `../../api`. Mock that module — the real data seam.
const clientMock = vi.hoisted(() => ({
  listFiles: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

// The download/share affordances delegate to the transport-aware helper. Mock
// it so we can assert intent without touching the DOM/Capacitor bridges.
const downloadShareMock = vi.hoisted(() => ({
  downloadAttachment: vi.fn(),
  shareAttachment: vi.fn(),
  canShareFiles: vi.fn(),
  filenameForMime: vi.fn((_mime: string, base?: string) => base ?? "download"),
}));

vi.mock("../../utils/download-share", () => downloadShareMock);

function file(overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    url: "/media/photo.png",
    hash: "hash-image",
    fileName: "photo.png",
    mimeType: "image/png",
    size: 2048,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

const FIXTURE_FILES: StoredFile[] = [
  file(),
  file({
    url: "/media/report.pdf",
    hash: "hash-pdf",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    size: 1_500_000,
    createdAt: 1_699_000_000_000,
  }),
];

beforeEach(() => {
  clientMock.listFiles.mockResolvedValue({ files: FIXTURE_FILES });
  clientMock.deleteFile.mockResolvedValue({ deleted: true });
  downloadShareMock.canShareFiles.mockReturnValue(true);
  downloadShareMock.shareAttachment.mockResolvedValue(true);
  downloadShareMock.downloadAttachment.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FilesView", () => {
  it("renders a row per stored file with kind facets and metadata", async () => {
    render(<FilesView />);

    expect(await screen.findByText("photo.png")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();

    const cards = screen.getAllByTestId("file-card");
    expect(cards).toHaveLength(2);

    // Kind is derived from mimeType.
    expect(cards[0].getAttribute("data-file-kind")).toBe("image");
    expect(cards[1].getAttribute("data-file-kind")).toBe("document");

    // Human size for the pdf (1.5MB → "1.4 MB").
    expect(within(cards[1]).getByText("1.4 MB")).toBeTruthy();
  });

  it("filters the grid by the selected type facet", async () => {
    render(<FilesView />);
    await screen.findByText("photo.png");

    fireEvent.click(screen.getByTestId("file-facet-document"));

    await waitFor(() => {
      expect(screen.getAllByTestId("file-card")).toHaveLength(1);
    });
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByText("photo.png")).toBeNull();

    // Images facet shows only the image.
    fireEvent.click(screen.getByTestId("file-facet-image"));
    await waitFor(() => {
      expect(screen.getAllByTestId("file-card")).toHaveLength(1);
    });
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.queryByText("report.pdf")).toBeNull();
  });

  it("downloads a file through the helper with its url + filename", async () => {
    render(<FilesView />);
    await screen.findByText("photo.png");

    const imageCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "photo.png");
    expect(imageCard).toBeTruthy();

    fireEvent.click(
      within(imageCard as HTMLElement).getByTestId("file-download"),
    );

    await waitFor(() => {
      expect(downloadShareMock.downloadAttachment).toHaveBeenCalledTimes(1);
    });
    const [url, filename] = downloadShareMock.downloadAttachment.mock.calls[0];
    expect(String(url)).toContain("photo.png");
    expect(filename).toBe("photo.png");
  });

  it("shares a file through the helper", async () => {
    render(<FilesView />);
    await screen.findByText("photo.png");

    const imageCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "photo.png");

    fireEvent.click(within(imageCard as HTMLElement).getByTestId("file-share"));

    await waitFor(() => {
      expect(downloadShareMock.shareAttachment).toHaveBeenCalledTimes(1);
    });
    const [url, opts] = downloadShareMock.shareAttachment.mock.calls[0];
    expect(String(url)).toContain("photo.png");
    expect(opts).toMatchObject({ title: "photo.png" });
  });

  it("hides the Share control when sharing is unsupported", async () => {
    downloadShareMock.canShareFiles.mockReturnValue(false);
    render(<FilesView />);
    await screen.findByText("photo.png");

    expect(screen.queryByTestId("file-share")).toBeNull();
    expect(screen.getAllByTestId("file-download").length).toBeGreaterThan(0);
  });

  it("deletes a file via the client and optimistically removes the row", async () => {
    render(<FilesView />);
    await screen.findByText("report.pdf");

    const pdfCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "report.pdf");

    fireEvent.click(within(pdfCard as HTMLElement).getByTestId("file-delete"));

    expect(window.confirm).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(clientMock.deleteFile).toHaveBeenCalledWith("report.pdf");
    });
    await waitFor(() => {
      expect(screen.queryByText("report.pdf")).toBeNull();
    });
    // The other file remains.
    expect(screen.getByText("photo.png")).toBeTruthy();
  });

  it("does not delete when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<FilesView />);
    await screen.findByText("report.pdf");

    const pdfCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "report.pdf");
    fireEvent.click(within(pdfCard as HTMLElement).getByTestId("file-delete"));

    expect(clientMock.deleteFile).not.toHaveBeenCalled();
    expect(screen.getByText("report.pdf")).toBeTruthy();
  });

  it("restores the row when the delete fails", async () => {
    clientMock.deleteFile.mockResolvedValue({ deleted: false });
    render(<FilesView />);
    await screen.findByText("report.pdf");

    const pdfCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "report.pdf");
    fireEvent.click(within(pdfCard as HTMLElement).getByTestId("file-delete"));

    await waitFor(() => {
      expect(clientMock.deleteFile).toHaveBeenCalledWith("report.pdf");
    });
    // Row comes back after the failed delete.
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeTruthy();
    });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("shows the empty state when there are no files", async () => {
    clientMock.listFiles.mockResolvedValue({ files: [] });
    render(<FilesView />);

    await waitFor(() => {
      expect(screen.getByTestId("files-empty")).toBeTruthy();
    });
  });

  it("surfaces an error when the list request fails", async () => {
    clientMock.listFiles.mockRejectedValue(new Error("boom"));
    render(<FilesView />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("shows the loading indicator until the list resolves, then clears it", async () => {
    // Hold listFiles open so we can observe the pending state deterministically.
    let resolve!: (v: { files: StoredFile[] }) => void;
    clientMock.listFiles.mockReturnValue(
      new Promise<{ files: StoredFile[] }>((r) => {
        resolve = r;
      }),
    );

    render(<FilesView />);

    // aria-busy + the loading affordance are live while the request is pending.
    expect(screen.getByTestId("files-loading")).toBeTruthy();
    expect(
      screen.getByTestId("files-view").getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByTestId("file-card")).toBeNull();

    await act(async () => {
      resolve({ files: FIXTURE_FILES });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("files-loading")).toBeNull();
    });
    expect(screen.getByTestId("files-view").getAttribute("aria-busy")).toBe(
      "false",
    );
    expect(screen.getAllByTestId("file-card")).toHaveLength(2);
  });

  it("narrows the grid to filename matches as the chat-binding query changes", async () => {
    render(<FilesView />);
    await screen.findByText("photo.png");

    // The active view takes over the floating composer; each keystroke flows in
    // through the registered onQuery. Case-insensitive substring on fileName.
    const binding = getViewChatBinding();
    expect(typeof binding?.onQuery).toBe("function");

    act(() => binding?.onQuery?.("REPORT"));

    await waitFor(() => {
      expect(screen.getAllByTestId("file-card")).toHaveLength(1);
    });
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByText("photo.png")).toBeNull();

    // Clearing the query restores the full grid.
    act(() => binding?.onQuery?.(""));
    await waitFor(() => {
      expect(screen.getAllByTestId("file-card")).toHaveLength(2);
    });
  });

  it("shows the filtered-empty panel when a query matches nothing", async () => {
    render(<FilesView />);
    await screen.findByText("photo.png");

    act(() => getViewChatBinding()?.onQuery?.("does-not-exist.zip"));

    await waitFor(() => {
      expect(screen.getByTestId("files-empty-filter")).toBeTruthy();
    });
    // Distinct from the true-empty state (files exist, none match).
    expect(screen.queryByTestId("files-empty")).toBeNull();
    expect(screen.queryByTestId("file-card")).toBeNull();
  });

  it("treats a non-array files payload as empty instead of crashing", async () => {
    // Adversarial DTO: server (or a broken proxy) returns a null list.
    clientMock.listFiles.mockResolvedValue({
      files: null as unknown as StoredFile[],
    });
    render(<FilesView />);

    await waitFor(() => {
      expect(screen.getByTestId("files-empty")).toBeTruthy();
    });
    expect(screen.queryByTestId("file-card")).toBeNull();
  });

  it("falls back to download when native share reports it did not share", async () => {
    downloadShareMock.shareAttachment.mockResolvedValue(false);
    render(<FilesView />);
    await screen.findByText("photo.png");

    const imageCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "photo.png");

    fireEvent.click(within(imageCard as HTMLElement).getByTestId("file-share"));

    await waitFor(() => {
      expect(downloadShareMock.shareAttachment).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(downloadShareMock.downloadAttachment).toHaveBeenCalledTimes(1);
    });
    const [url, filename] = downloadShareMock.downloadAttachment.mock.calls[0];
    expect(String(url)).toContain("photo.png");
    expect(filename).toBe("photo.png");
  });

  it("restores the row and surfaces an alert when delete throws", async () => {
    clientMock.deleteFile.mockRejectedValue(new Error("network down"));
    render(<FilesView />);
    await screen.findByText("report.pdf");

    const pdfCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "report.pdf");
    fireEvent.click(within(pdfCard as HTMLElement).getByTestId("file-delete"));

    await waitFor(() => {
      expect(clientMock.deleteFile).toHaveBeenCalledWith("report.pdf");
    });
    // The optimistic removal is rolled back after the rejection.
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeTruthy();
    });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("retries the load after an error and renders the recovered list", async () => {
    clientMock.listFiles
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ files: FIXTURE_FILES });
    render(<FilesView />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });

    fireEvent.click(
      within(screen.getByRole("alert")).getByText(/retry/i),
    );

    await waitFor(() => {
      expect(screen.getByText("photo.png")).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clientMock.listFiles).toHaveBeenCalledTimes(2);
  });

  it("does not fire a second delete when the same row is double-clicked", async () => {
    // Hold the delete open so the optimistic UI + deleting flag settle between
    // the burst of clicks and the resolution.
    let resolveDelete!: (v: { deleted: boolean }) => void;
    clientMock.deleteFile.mockReturnValue(
      new Promise<{ deleted: boolean }>((r) => {
        resolveDelete = r;
      }),
    );
    render(<FilesView />);
    await screen.findByText("report.pdf");

    const pdfCard = screen
      .getAllByTestId("file-card")
      .find((c) => c.getAttribute("data-file-name") === "report.pdf");
    const btn = within(pdfCard as HTMLElement).getByTestId("file-delete");

    // Rapid double-fire in a single synchronous burst.
    fireEvent.click(btn);
    fireEvent.click(btn);

    // Exactly one request goes out, keyed on the filename — no duplicate DELETE.
    await waitFor(() => {
      expect(clientMock.deleteFile).toHaveBeenCalledTimes(1);
    });
    expect(clientMock.deleteFile).toHaveBeenCalledWith("report.pdf");
    expect(window.confirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete({ deleted: true });
    });
    await waitFor(() => {
      expect(screen.queryByText("report.pdf")).toBeNull();
    });
  });
});
