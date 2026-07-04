// @vitest-environment jsdom

/**
 * Native HTML5 file-drop coverage for the Knowledge/Documents upload surface
 * (#10722) — the only drag-drop upload affordance on the documents surface. The
 * tests drive a real `drop` DOM event carrying a populated `dataTransfer.files`
 * and assert the SEMANTIC outcome:
 *
 *   • UploadZone.handleDrop  → onFilesUpload fires with the dropped File(s) and
 *     the zone's live scope options; a same-node drop does not bubble into the
 *     DocumentsView root (stopPropagation), so it never double-uploads.
 *   • DocumentsView root drop → the real handleFilesUpload validation +
 *     batching path runs and client.uploadDocumentsBulk is called with the
 *     dropped file's decoded content. Wrong-type / empty / no-file drops are
 *     rejected before any network call.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentUploadFile } from "./documents-upload.helpers";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const clientMock = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  uploadDocumentsBulk: vi.fn(),
  searchDocuments: vi.fn(),
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useTranslation: () => ({ t: appMock.value.t }),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state/view-chat-binding", () => ({
  useRegisterViewChatBinding: () => {},
}));
vi.mock("../../utils/desktop-dialogs", () => ({
  confirmDesktopAction: vi.fn(async () => true),
}));

import { DocumentsView } from "./DocumentsView";
import { UploadZone } from "./documents-upload";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

/**
 * A minimal DataTransfer stand-in. jsdom does not implement DataTransfer, so we
 * hand-build the shape the handlers actually read: `.files` (Array.from'd) and
 * `.types` (`includes("Files")` on the root dragover gate), plus the mutable
 * effect fields the drag handlers assign to.
 */
function makeDataTransfer(files: File[]) {
  const store: Record<string, string> = {};
  return {
    files,
    items: files.map((f) => ({
      kind: "file",
      type: f.type,
      getAsFile: () => f,
    })),
    types: files.length > 0 ? ["Files"] : [],
    dropEffect: "none",
    effectAllowed: "all",
    setData: (key: string, value: string) => {
      store[key] = value;
    },
    getData: (key: string) => store[key] ?? "",
    setDragImage: () => {},
  };
}

function txtFile(name: string, body: string, type = "text/plain") {
  return new File([body], name, { type }) as DocumentUploadFile;
}

beforeEach(() => {
  appMock.value = { t, setActionNotice: vi.fn() };
  clientMock.listDocuments.mockReset();
  clientMock.uploadDocumentsBulk.mockReset();
  clientMock.searchDocuments.mockReset();
  clientMock.listDocuments.mockResolvedValue({ documents: [] });
  clientMock.uploadDocumentsBulk.mockResolvedValue({
    results: [{ index: 0, ok: true, filename: "notes.txt" }],
  });
});

afterEach(() => cleanup());

describe("UploadZone — native file drop (handleDrop)", () => {
  it("forwards a single dropped file to onFilesUpload with the zone's scope options", () => {
    const onFilesUpload = vi.fn();
    const { container } = render(
      <UploadZone
        onFilesUpload={onFilesUpload}
        onTextUpload={vi.fn()}
        onUrlUpload={vi.fn()}
        uploading={false}
        uploadStatus={null}
      />,
    );
    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;
    const file = txtFile("readme.md", "# hello", "text/markdown");

    fireEvent.drop(zone, { dataTransfer: makeDataTransfer([file]) });

    expect(onFilesUpload).toHaveBeenCalledTimes(1);
    const [files, options] = onFilesUpload.mock.calls[0];
    expect(files).toHaveLength(1);
    expect((files[0] as File).name).toBe("readme.md");
    // Default scope + AI image descriptions are the zone's live options.
    expect(options).toEqual({
      includeImageDescriptions: true,
      scope: "user-private",
    });
  });

  it("forwards every file when multiple are dropped at once", () => {
    const onFilesUpload = vi.fn();
    const { container } = render(
      <UploadZone
        onFilesUpload={onFilesUpload}
        onTextUpload={vi.fn()}
        onUrlUpload={vi.fn()}
        uploading={false}
        uploadStatus={null}
      />,
    );
    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;
    const files = [
      txtFile("a.txt", "a"),
      txtFile("b.txt", "b"),
      txtFile("c.txt", "c"),
    ];

    fireEvent.drop(zone, { dataTransfer: makeDataTransfer(files) });

    expect(onFilesUpload).toHaveBeenCalledTimes(1);
    const dropped = onFilesUpload.mock.calls[0][0] as File[];
    expect(dropped.map((f) => f.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("ignores a drop that carries no files (empty drop)", () => {
    const onFilesUpload = vi.fn();
    const { container } = render(
      <UploadZone
        onFilesUpload={onFilesUpload}
        onTextUpload={vi.fn()}
        onUrlUpload={vi.fn()}
        uploading={false}
        uploadStatus={null}
      />,
    );
    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;

    fireEvent.drop(zone, { dataTransfer: makeDataTransfer([]) });

    expect(onFilesUpload).not.toHaveBeenCalled();
  });

  it("ignores a drop while an upload is already in flight", () => {
    const onFilesUpload = vi.fn();
    const { container } = render(
      <UploadZone
        onFilesUpload={onFilesUpload}
        onTextUpload={vi.fn()}
        onUrlUpload={vi.fn()}
        uploading={true}
        uploadStatus={{ current: 1, total: 2, filename: "x" }}
      />,
    );
    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;

    fireEvent.drop(zone, {
      dataTransfer: makeDataTransfer([txtFile("a.txt", "a")]),
    });

    expect(onFilesUpload).not.toHaveBeenCalled();
  });

  it("stops a zone drop from bubbling into an outer drop target (no double-upload)", () => {
    const onFilesUpload = vi.fn();
    const outerDrop = vi.fn();
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test-only outer drop target
      <div onDrop={outerDrop} data-testid="outer">
        <UploadZone
          onFilesUpload={onFilesUpload}
          onTextUpload={vi.fn()}
          onUrlUpload={vi.fn()}
          uploading={false}
          uploadStatus={null}
        />
      </div>,
    );
    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;

    fireEvent.drop(zone, {
      dataTransfer: makeDataTransfer([txtFile("a.txt", "a")]),
    });

    expect(onFilesUpload).toHaveBeenCalledTimes(1);
    // event.stopPropagation() in handleDrop must keep the outer handler dark.
    expect(outerDrop).not.toHaveBeenCalled();
  });

  it("carries the newly selected scope into the drop options", () => {
    const onFilesUpload = vi.fn();
    const { container, getByRole } = render(
      <UploadZone
        onFilesUpload={onFilesUpload}
        onTextUpload={vi.fn()}
        onUrlUpload={vi.fn()}
        uploading={false}
        uploadStatus={null}
      />,
    );
    // Switch scope from the default (user-private) to Global before dropping.
    fireEvent.click(getByRole("button", { name: "Global" }));

    const zone = container.querySelector("fieldset") as HTMLFieldSetElement;
    fireEvent.drop(zone, {
      dataTransfer: makeDataTransfer([txtFile("a.txt", "a")]),
    });

    expect(onFilesUpload).toHaveBeenCalledTimes(1);
    expect(onFilesUpload.mock.calls[0][1]).toEqual({
      includeImageDescriptions: true,
      scope: "global",
    });
  });
});

describe("DocumentsView — root file drop drives the real upload path", () => {
  async function renderView() {
    const utils = render(<DocumentsView />);
    // Wait for the initial listDocuments load to settle so the root is stable.
    await waitFor(() => expect(clientMock.listDocuments).toHaveBeenCalled());
    const root = utils.getByTestId("documents-view");
    return { ...utils, root };
  }

  it("uploads a dropped .txt file with its decoded content via uploadDocumentsBulk", async () => {
    const { root } = await renderView();
    const file = txtFile("notes.txt", "hello world");

    fireEvent.drop(root, { dataTransfer: makeDataTransfer([file]) });

    await waitFor(() =>
      expect(clientMock.uploadDocumentsBulk).toHaveBeenCalledTimes(1),
    );
    const payload = clientMock.uploadDocumentsBulk.mock.calls[0][0] as {
      documents: Array<{ content: string; filename: string; scope: string }>;
    };
    expect(payload.documents).toHaveLength(1);
    expect(payload.documents[0]).toMatchObject({
      content: "hello world",
      filename: "notes.txt",
      scope: "user-private",
    });
  });

  it("batches multiple dropped files into one bulk upload request", async () => {
    clientMock.uploadDocumentsBulk.mockResolvedValue({
      results: [
        { index: 0, ok: true, filename: "one.txt" },
        { index: 1, ok: true, filename: "two.txt" },
      ],
    });
    const { root } = await renderView();

    fireEvent.drop(root, {
      dataTransfer: makeDataTransfer([
        txtFile("one.txt", "first"),
        txtFile("two.txt", "second"),
      ]),
    });

    await waitFor(() =>
      expect(clientMock.uploadDocumentsBulk).toHaveBeenCalledTimes(1),
    );
    const payload = clientMock.uploadDocumentsBulk.mock.calls[0][0] as {
      documents: Array<{ content: string; filename: string }>;
    };
    expect(payload.documents.map((d) => d.filename)).toEqual([
      "one.txt",
      "two.txt",
    ]);
    expect(payload.documents.map((d) => d.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects an unsupported file type without any upload request", async () => {
    const { root } = await renderView();

    fireEvent.drop(root, {
      dataTransfer: makeDataTransfer([
        new File(["MZ"], "malware.exe", {
          type: "application/octet-stream",
        }) as DocumentUploadFile,
      ]),
    });

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        "No supported non-empty files were selected.",
        "info",
        3000,
      ),
    );
    expect(clientMock.uploadDocumentsBulk).not.toHaveBeenCalled();
  });

  it("rejects a supported-but-empty file (zero bytes) without an upload", async () => {
    const { root } = await renderView();

    fireEvent.drop(root, {
      dataTransfer: makeDataTransfer([txtFile("empty.txt", "")]),
    });

    await waitFor(() =>
      expect(appMock.value.setActionNotice).toHaveBeenCalledWith(
        "No non-empty files were selected.",
        "info",
        3000,
      ),
    );
    expect(clientMock.uploadDocumentsBulk).not.toHaveBeenCalled();
  });

  it("does nothing when a drop carries no files at all", async () => {
    const { root } = await renderView();

    fireEvent.drop(root, { dataTransfer: makeDataTransfer([]) });

    // Give any (incorrectly-armed) async path a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMock.uploadDocumentsBulk).not.toHaveBeenCalled();
    expect(appMock.value.setActionNotice).not.toHaveBeenCalled();
  });
});
