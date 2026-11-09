/** Base64 file writes reject content Buffer.from would silently corrupt. */
import fsp from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVirtualFilesystemService } from "../services/virtual-filesystem.ts";
import type { WorkbenchRouteContext } from "./workbench-context.ts";
import { handleWorkbenchVfsRoutes } from "./workbench-vfs-routes.ts";

let stateDir: string;
const previousStateDir = process.env.ELIZA_STATE_DIR;

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-base64-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  await fsp.rm(stateDir, { recursive: true, force: true });
});

async function putFile(body: Record<string, unknown>) {
  const result: { status: number; body: unknown } = { status: 0, body: null };
  const pathname = "/api/workbench/vfs/projects/b64/file";
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "PUT",
    pathname,
    url: new URL(`http://127.0.0.1${pathname}`),
    state: { runtime: null, adminEntityId: null },
    json: (_res, data, status = 200) => {
      result.status = status;
      result.body = data;
    },
    error: (_res, message, status = 500) => {
      result.status = status;
      result.body = { error: message };
    },
    readJsonBody: async <T extends object>() => body as T,
    decodePathComponent: (raw) => decodeURIComponent(raw),
    toWorkbenchTodo: () => null,
    taskToTriggerSummary: () => null,
    listTriggerTasks: async () => [],
  } satisfies WorkbenchRouteContext;
  expect(await handleWorkbenchVfsRoutes(ctx)).toBe(true);
  return result;
}

describe("workbench VFS base64 writes", () => {
  it("returns 400 and writes nothing for invalid base64", async () => {
    for (const content of ["aGVsbG8*", "aGVsbG8", "a GVsbG8="]) {
      const result = await putFile({
        path: "bad.bin",
        content,
        encoding: "base64",
      });
      expect(result).toEqual({
        status: 400,
        body: { error: "content is not valid base64" },
      });
    }
    const vfs = createVirtualFilesystemService({ projectId: "b64", stateDir });
    await vfs.initialize();
    await expect(vfs.readFile("bad.bin")).rejects.toThrow();
  });

  it("writes the decoded bytes for valid base64", async () => {
    const result = await putFile({
      path: "good.bin",
      content: Buffer.from("hello").toString("base64"),
      encoding: "base64",
    });
    expect(result.status).toBe(200);
    const vfs = createVirtualFilesystemService({ projectId: "b64", stateDir });
    expect(await vfs.readFile("good.bin")).toBe("hello");
  });
});
