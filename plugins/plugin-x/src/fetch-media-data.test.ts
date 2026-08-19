/**
 * Overflow coverage for {@link fetchMediaData}: remote attachment URLs must
 * go through the capped core media fetcher, and local files larger than the
 * connector attachment cap must fail before readFile.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
  fetchRemoteMedia,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMediaData } from "./utils";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    fetchRemoteMedia: vi.fn(actual.fetchRemoteMedia),
  };
});

const mockedFetchRemoteMedia = vi.mocked(fetchRemoteMedia);

afterEach(() => {
  mockedFetchRemoteMedia.mockReset();
});

describe("fetchMediaData", () => {
  it("fetches HTTP attachments through the capped remote media helper", async () => {
    mockedFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("png"),
      contentType: "image/png",
    });

    await expect(
      fetchMediaData([
        {
          id: "att-1",
          url: "https://cdn.example/photo.png",
        },
      ]),
    ).resolves.toEqual([{ data: Buffer.from("png"), mediaType: "image/png" }]);

    expect(mockedFetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://cdn.example/photo.png",
      maxBytes: DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES,
      timeoutMs: 30_000,
    });
  });

  it("rejects a local file larger than the connector attachment cap before read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-media-"));
    const filePath = path.join(dir, "oversize.bin");
    const handle = await fs.open(filePath, "w");
    try {
      await handle.truncate(DEFAULT_CONNECTOR_ATTACHMENT_MAX_BYTES + 1);
    } finally {
      await handle.close();
    }

    const readFileSpy = vi.spyOn(fs, "readFile");
    try {
      await expect(
        fetchMediaData([
          {
            id: "att-2",
            url: filePath,
          },
        ]),
      ).rejects.toMatchObject({
        name: "ElizaError",
        code: "X_ATTACHMENT_TOO_LARGE",
      });
      expect(readFileSpy).not.toHaveBeenCalled();
    } finally {
      readFileSpy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a local file at or under the cap", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-media-"));
    const filePath = path.join(dir, "ok.bin");
    await fs.writeFile(filePath, Buffer.from("ok"));

    try {
      await expect(
        fetchMediaData([
          {
            id: "att-3",
            url: filePath,
          },
        ]),
      ).resolves.toEqual([{ data: Buffer.from("ok"), mediaType: "image/png" }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
