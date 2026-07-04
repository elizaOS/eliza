/**
 * Covers filesAction over the content-addressed file store: op validation,
 * newest-first listing, query filter, get-by-name, and delete confirm-gating,
 * plus graceful degradation when storage is absent. The store is a vi.fn fake.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { filesAction } from "./files.ts";

// ServiceType.REMOTE_FILES === "aws_s3"
const REMOTE_FILES = "aws_s3";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const sample = [
  {
    fileName: `${HASH_A}.png`,
    url: `/api/media/${HASH_A}.png`,
    hash: HASH_A,
    mimeType: "image/png",
    size: 2048,
    createdAt: 2,
  },
  {
    fileName: `${HASH_B}.pdf`,
    url: `/api/media/${HASH_B}.pdf`,
    hash: HASH_B,
    mimeType: "application/pdf",
    size: 5000,
    createdAt: 1,
  },
];

function fakeStorage(files = sample) {
  return {
    list: vi.fn(async () => [...files]),
    getUrl: (name: string) =>
      /^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) ? `/api/media/${name}` : null,
    exists: vi.fn(async (name: string) =>
      files.some((file) => file.fileName === name),
    ),
    delete: vi.fn(async (name: string) =>
      files.some((file) => file.fileName === name),
    ),
  };
}

function makeRuntime(storage: unknown): IAgentRuntime {
  return {
    getService: (type: string) => (type === REMOTE_FILES ? storage : null),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function run(runtime: IAgentRuntime, params: Record<string, unknown>) {
  return filesAction.handler?.(
    runtime,
    {} as never,
    {} as never,
    { parameters: params } as never,
  );
}

type FilesData = {
  files?: Array<{ fileName: string; mimeType: string }>;
  total?: number;
  deleted?: boolean;
  error?: string;
};

describe("filesAction", () => {
  it("requires a valid op", async () => {
    const res = await run(makeRuntime(fakeStorage()), {});
    expect(res?.success).toBe(false);
    expect((res?.data as FilesData)?.error).toBe("FILES_INVALID");
  });

  it("lists stored files newest-first", async () => {
    const res = await run(makeRuntime(fakeStorage()), { op: "list" });
    expect(res?.success).toBe(true);
    const data = res?.data as FilesData;
    expect(data.total).toBe(2);
    expect(data.files?.[0].fileName).toBe(`${HASH_A}.png`); // createdAt 2 > 1
  });

  it("filters list by query (mime or filename substring)", async () => {
    const res = await run(makeRuntime(fakeStorage()), {
      op: "list",
      query: "pdf",
    });
    const data = res?.data as FilesData;
    expect(data.files).toHaveLength(1);
    expect(data.files?.[0].mimeType).toBe("application/pdf");
  });

  it("gets a file's details + url by name", async () => {
    const res = await run(makeRuntime(fakeStorage()), {
      op: "get",
      fileName: `${HASH_A}.png`,
    });
    expect(res?.success).toBe(true);
    expect(res?.text).toContain(`/api/media/${HASH_A}.png`);
  });

  it("reports not-found for an unknown file in get", async () => {
    const res = await run(makeRuntime(fakeStorage()), {
      op: "get",
      fileName: `${"c".repeat(64)}.png`,
    });
    expect(res?.success).toBe(false);
    expect((res?.data as FilesData)?.error).toBe("FILES_NOT_FOUND");
  });

  it("requires confirm:true to delete", async () => {
    const res = await run(makeRuntime(fakeStorage()), {
      op: "delete",
      fileName: `${HASH_A}.png`,
    });
    expect(res?.success).toBe(false);
    expect((res?.data as FilesData)?.error).toBe("FILES_CONFIRM_REQUIRED");
  });

  it("deletes with confirm:true", async () => {
    const storage = fakeStorage();
    const res = await run(makeRuntime(storage), {
      op: "delete",
      fileName: `${HASH_A}.png`,
      confirm: true,
    });
    expect(res?.success).toBe(true);
    expect(storage.delete).toHaveBeenCalledWith(`${HASH_A}.png`);
  });

  it("degrades gracefully when the storage service is absent", async () => {
    const res = await run(makeRuntime(null), { op: "list" });
    expect(res?.success).toBe(false);
    expect((res?.data as FilesData)?.error).toBe("FILES_NO_SERVICE");
  });
});
