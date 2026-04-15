import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/files.js", () => ({
  appendFile: vi.fn(() => ({ success: true, path: "/tmp/file.txt", message: "appended" })),
  deleteDirectory: vi.fn(() => ({ success: true, path: "/tmp/dir", message: "deleted dir" })),
  deleteFile: vi.fn(() => ({ success: true, path: "/tmp/file.txt", message: "deleted file" })),
  fileDownload: vi.fn(),
  fileExists: vi.fn(() => ({ success: true, exists: true })),
  fileListDownloads: vi.fn(),
  fileUpload: vi.fn(),
  listDirectory: vi.fn(() => ({ success: true, items: [{ name: "a.txt", type: "file", path: "/tmp/a.txt" }], count: 1 })),
  readFile: vi.fn(() => ({ success: true, path: "/tmp/file.txt", content: "hello" })),
  writeFile: vi.fn(() => ({ success: true, path: "/tmp/file.txt", message: "written" })),
  editFile: vi.fn(() => ({ success: true, path: "/tmp/file.txt", message: "edited" })),
}));

import { fileAction } from "../actions/file-action.js";
import {
  appendFile,
  deleteDirectory,
  deleteFile,
  fileDownload,
  fileExists,
  fileListDownloads,
  fileUpload,
  listDirectory,
  readFile,
  writeFile,
  editFile,
} from "../platform/files.js";

describe("fileAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("describes the file surface", () => {
    expect(fileAction.name).toBe("FILE_ACTION");
    expect(fileAction.description).toContain("file_read");
    expect(fileAction.description).toContain("file_write");
    expect(fileAction.description).toContain("file_upload");
    expect(fileAction.description).toContain("directory_delete");
  });

  it("normalizes file aliases and path aliases", async () => {
    await fileAction.handler(
      {} as any,
      { content: { action: "file_upload", filepath: "/tmp/file.txt", content: "hello" } } as any,
      undefined,
      { parameters: { action: "file_upload", filepath: "/tmp/file.txt", content: "hello" } } as any,
    );

    expect(fileUpload).toHaveBeenCalledWith({ path: "/tmp/file.txt", content: "hello" });
    expect(writeFile).not.toHaveBeenCalled();

    await fileAction.handler(
      {} as any,
      { content: { action: "file_edit", path: "/tmp/file.txt", find: "alpha", replace: "beta" } } as any,
      undefined,
      { parameters: { action: "file_edit", path: "/tmp/file.txt", find: "alpha", replace: "beta" } } as any,
    );

    expect(editFile).toHaveBeenCalledWith({
      path: "/tmp/file.txt",
      old_text: "alpha",
      new_text: "beta",
    });
  });

  it("routes the remaining file actions", async () => {
    await fileAction.handler(
      {} as any,
      { content: { action: "file_read", path: "/tmp/file.txt" } } as any,
      undefined,
      { parameters: { action: "file_read", path: "/tmp/file.txt" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "file_append", path: "/tmp/file.txt", content: "x" } } as any,
      undefined,
      { parameters: { action: "file_append", path: "/tmp/file.txt", content: "x" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "file_delete", path: "/tmp/file.txt" } } as any,
      undefined,
      { parameters: { action: "file_delete", path: "/tmp/file.txt" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "file_exists", path: "/tmp/file.txt" } } as any,
      undefined,
      { parameters: { action: "file_exists", path: "/tmp/file.txt" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "directory_list", path: "/tmp" } } as any,
      undefined,
      { parameters: { action: "directory_list", path: "/tmp" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "directory_delete", path: "/tmp/dir" } } as any,
      undefined,
      { parameters: { action: "directory_delete", path: "/tmp/dir" } } as any,
    );

    expect(readFile).toHaveBeenCalled();
    expect(appendFile).toHaveBeenCalled();
    expect(deleteFile).toHaveBeenCalled();
    expect(fileExists).toHaveBeenCalled();
    expect(listDirectory).toHaveBeenCalled();
    expect(deleteDirectory).toHaveBeenCalled();
  });

  it("supports download aliases", async () => {
    await fileAction.handler(
      {} as any,
      { content: { action: "file_download", path: "/tmp/file.txt" } } as any,
      undefined,
      { parameters: { action: "file_download", path: "/tmp/file.txt" } } as any,
    );
    await fileAction.handler(
      {} as any,
      { content: { action: "file_list_downloads", path: "/tmp" } } as any,
      undefined,
      { parameters: { action: "file_list_downloads", path: "/tmp" } } as any,
    );

    expect(fileDownload).toHaveBeenCalledWith({ path: "/tmp/file.txt", encoding: undefined });
    expect(fileListDownloads).toHaveBeenCalledWith({ path: "/tmp" });
    expect(readFile).not.toHaveBeenCalled();
    expect(listDirectory).not.toHaveBeenCalled();
  });
});
