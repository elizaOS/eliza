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

type ProjectResponse = {
  project: {
    projectId: string;
    root?: unknown;
    filesRoot?: unknown;
  };
  quota?: unknown;
};

type SnapshotResponse = {
  snapshot: {
    id: string;
    root?: unknown;
  };
};

type PluginsResponse = {
  plugins: Array<Record<string, unknown>>;
};

type ErrorResponse = {
  error: string;
};

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "workbench-vfs-"));
  oldStateDir = process.env.ELIZA_STATE_DIR;
  oldBuildVariant = process.env.MILADY_BUILD_VARIANT;
  process.env.ELIZA_STATE_DIR = tmpDir;
  delete process.env.MILADY_BUILD_VARIANT;
  _resetBuildVariantForTests();
});

afterEach(async () => {
  if (oldStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = oldStateDir;
  }
  if (oldBuildVariant === undefined) {
    delete process.env.MILADY_BUILD_VARIANT;
  } else {
    process.env.MILADY_BUILD_VARIANT = oldBuildVariant;
  }
  _resetBuildVariantForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("workbench VFS routes", () => {
  it("creates a project, writes files, snapshots, diffs, and reads content", async () => {
    const create = await callRoute<ProjectResponse>(
      "POST",
      "/api/workbench/vfs/projects",
      {
        projectId: "agentic-ide",
      },
    );
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({
      project: { projectId: "agentic-ide" },
      quota: { usedBytes: 0, fileCount: 0 },
    });

    const write = await callRoute(
      "PUT",
      "/api/workbench/vfs/projects/agentic-ide/file",
      {
        path: "src/plugin.ts",
        content: "export default { name: 'vfs-demo' };",
      },
    );
    expect(write.status).toBe(200);
    expect(write.body).toMatchObject({
      file: { path: "/src/plugin.ts", type: "file" },
    });

    const snapshot = await callRoute<SnapshotResponse>(
      "POST",
      "/api/workbench/vfs/projects/agentic-ide/snapshots",
      { note: "before edit" },
    );
    const snapshotId = snapshot.body.snapshot.id;
    expect(snapshot.status).toBe(201);
    expect(snapshotId).toBeTruthy();
    expect(snapshot.body.snapshot.root).toBeUndefined();

    await callRoute("PUT", "/api/workbench/vfs/projects/agentic-ide/file", {
      path: "src/plugin.ts",
      content: "export default { name: 'vfs-demo-2' };",
    });

    const diff = await callRoute(
      "GET",
      `/api/workbench/vfs/projects/agentic-ide/diff?snapshotId=${encodeURIComponent(snapshotId)}`,
    );
    expect(diff.body.diff).toMatchObject([
      { path: "/src/plugin.ts", status: "modified" },
    ]);

    const read = await callRoute(
      "GET",
      "/api/workbench/vfs/projects/agentic-ide/file?path=src/plugin.ts",
    );
    expect(read.body).toMatchObject({
      path: "/src/plugin.ts",
      encoding: "utf-8",
      content: "export default { name: 'vfs-demo-2' };",
    });
  });

  it("does not expose host filesystem paths in public VFS views", async () => {
    const create = await callRoute<ProjectResponse>(
      "POST",
      "/api/workbench/vfs/projects",
      {
        projectId: "redacted",
      },
    );
    expect(create.body.project).toEqual({ projectId: "redacted" });
    expect(create.body.project.root).toBeUndefined();
    expect(create.body.project.filesRoot).toBeUndefined();

    const plugins = await callRoute<PluginsResponse>(
      "GET",
      "/api/workbench/vfs/plugins",
    );
    expect(plugins.status).toBe(200);
    for (const plugin of plugins.body.plugins) {
      expect(plugin.diskPath).toBeUndefined();
    }
  });

  it("blocks host plugin compilation and loading in store builds", async () => {
    process.env.MILADY_BUILD_VARIANT = "store";
    _resetBuildVariantForTests();

    const compile = await callRoute<ErrorResponse>(
      "POST",
      "/api/workbench/vfs/projects/agentic-ide/compile-plugin",
      { entry: "src/plugin.ts" },
    );
    expect(compile.status).toBe(403);
    expect(compile.body.error).toContain("direct download build");

    const load = await callRoute<ErrorResponse>(
      "POST",
      "/api/workbench/vfs/projects/agentic-ide/load-plugin",
      { entry: "src/plugin.ts" },
    );
    expect(load.status).toBe(403);
    expect(load.body.error).toContain("direct download build");
  });

  it("rejects unsupported files collection methods", async () => {
    const response = await callRoute<ErrorResponse>(
      "POST",
      "/api/workbench/vfs/projects/agentic-ide/files",
    );

    expect(response.status).toBe(405);
    expect(response.body.error).toBe("Unsupported VFS files method");
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
