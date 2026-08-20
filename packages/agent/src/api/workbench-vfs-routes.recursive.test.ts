/** Exercises recursive VFS-list validation through the deterministic route harness. */
import fsp from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { _resetBuildVariantForTests } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleWorkbenchRoutes,
  type WorkbenchRouteContext,
} from "./workbench-routes.ts";

let tmpDir: string;
let oldStateDir: string | undefined;
let oldBuildVariant: string | undefined;

type FilesResponse = {
  files: Array<{ path: string; type: string }>;
};

type ErrorResponse = {
  error: string;
};

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "workbench-vfs-recursive-"),
  );
  oldStateDir = process.env.ELIZA_STATE_DIR;
  oldBuildVariant = process.env.ELIZA_BUILD_VARIANT;
  process.env.ELIZA_STATE_DIR = tmpDir;
  delete process.env.ELIZA_BUILD_VARIANT;
  _resetBuildVariantForTests();
});

afterEach(async () => {
  if (oldStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = oldStateDir;
  }
  if (oldBuildVariant === undefined) {
    delete process.env.ELIZA_BUILD_VARIANT;
  } else {
    process.env.ELIZA_BUILD_VARIANT = oldBuildVariant;
  }
  _resetBuildVariantForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("GET workbench VFS files recursive identity", () => {
  beforeEach(async () => {
    const created = await callRoute("POST", "/api/workbench/vfs/projects", {
      projectId: "recursive-tax",
    });
    expect(created.status).toBe(201);
    await callRoute("PUT", "/api/workbench/vfs/projects/recursive-tax/file", {
      path: "src/root.ts",
      content: "export const root = 1;\n",
    });
    await callRoute("PUT", "/api/workbench/vfs/projects/recursive-tax/file", {
      path: "src/nested/child.ts",
      content: "export const child = 2;\n",
    });
  });

  it.each([
    "/api/workbench/vfs/projects/recursive-tax/files?path=src",
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=",
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=false",
  ])("accepts %s as the shallow list", async (url) => {
    const result = await callRoute<FilesResponse>("GET", url);
    expect(result.status).toBe(200);
    const paths = result.body.files.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/src/root.ts", "/src/nested"]),
    );
    expect(paths).not.toContain("/src/nested/child.ts");
  });

  it("accepts recursive=true as the nested list", async () => {
    const result = await callRoute<FilesResponse>(
      "GET",
      "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=true",
    );
    expect(result.status).toBe(200);
    const paths = result.body.files.map((entry) => entry.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/src/root.ts",
        "/src/nested",
        "/src/nested/child.ts",
      ]),
    );
  });

  it.each(["TRUE", "1", "0", "FALSE", "yes", "no", "foo", "1e2"])(
    "rejects recursive=%s before listing nested files",
    async (token) => {
      const result = await callRoute<ErrorResponse>(
        "GET",
        `/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=${encodeURIComponent(token)}`,
      );
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "Invalid recursive" });
    },
  );

  it.each([
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=true&recursive=true",
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=true&recursive=false",
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=&recursive=true",
    "/api/workbench/vfs/projects/recursive-tax/files?path=src&recursive=foo&recursive=true",
  ])("rejects duplicate recursive values in %s", async (url) => {
    const result = await callRoute<ErrorResponse>("GET", url);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid recursive" });
  });
});

async function callRoute<TBody extends object = Record<string, unknown>>(
  method: string,
  route: string,
  body?: Record<string, unknown>,
) {
  const result: { body?: unknown; status?: number } = {};
  const url = new URL(route, "http://localhost");
  const ctx: WorkbenchRouteContext = {
    req: { url: route, method } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    state: { runtime: null, adminEntityId: null },
    json: (_res, data, status = 200) => {
      result.body = data;
      result.status = status;
    },
    error: (_res, message, status = 500) => {
      result.body = { error: message };
      result.status = status;
    },
    readJsonBody: async <T extends object>() => (body ?? {}) as T,
    toWorkbenchTodo: () => null,
    normalizeTags: () => [],
    readTaskMetadata: () => ({}),
    readTaskCompleted: () => false,
    parseNullableNumber: () => null,
    asObject: () => null,
    decodePathComponent: (raw) => decodeURIComponent(raw),
    taskToTriggerSummary: () => null,
    listTriggerTasks: async () => [],
  };
  const handled = await handleWorkbenchRoutes(ctx);
  expect(handled).toBe(true);
  return result as { body: TBody; status: number };
}
