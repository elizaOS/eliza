// @vitest-environment jsdom

// Renders the real FilesView against a mocked `../../api` client to cover the
// stored-file grid: per-file rows with kind facets, facet filtering, and the
// download/share hand-off (with the Share control hidden when unsupported).
// jsdom; the api client and the download/share helper are stubbed. Renders
// wrap in RoleProvider (OWNER by default) because the delete affordance is
// role-gated (#14781).

import type { RoleGateRole } from "@elizaos/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFile } from "../../api";
import { RoleProvider } from "../../hooks/useRole";
import { FilesView } from "./FilesView";

function renderFiles(role: RoleGateRole = "OWNER") {
  return render(
    <RoleProvider role={role}>
      <FilesView />
    </RoleProvider>,
  );
}

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
    renderFiles();

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
    renderFiles();
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
    renderFiles();
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
    renderFiles();
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
    renderFiles();
    await screen.findByText("photo.png");

    expect(screen.queryByTestId("file-share")).toBeNull();
    expect(screen.getAllByTestId("file-download").length).toBeGreaterThan(0);
  });

  it("deletes a file via the client and optimistically removes the row", async () => {
    renderFiles();
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
    renderFiles();
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
    renderFiles();
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
    renderFiles();

    await waitFor(() => {
      expect(screen.getByTestId("files-empty")).toBeTruthy();
    });
  });

  it("surfaces an error when the list request fails", async () => {
    clientMock.listFiles.mockRejectedValue(new Error("boom"));
    renderFiles();

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toContain("boom");
  });

  it("renders the designed restricted state (not empty, not error) for a restricted viewer (#14781)", async () => {
    clientMock.listFiles.mockResolvedValue({ files: [], restricted: true });
    renderFiles("USER");

    await waitFor(() => {
      expect(screen.getByTestId("files-restricted")).toBeTruthy();
    });
    // Three-state rule: restricted is its own render — no healthy-empty, no error.
    expect(screen.queryByTestId("files-empty")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides the delete affordance below ADMIN rank (#14781)", async () => {
    renderFiles("USER");
    await screen.findByText("photo.png");

    expect(screen.queryAllByTestId("file-delete")).toHaveLength(0);
    // Non-destructive affordances stay available.
    expect(screen.getAllByTestId("file-download").length).toBeGreaterThan(0);
  });
});
