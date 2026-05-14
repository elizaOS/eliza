import crypto from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import {
  buildStoreVariantBlockedMessage,
  isLocalCodeExecutionAllowed,
} from "@elizaos/core";
import type {
  CloudVfsBundle,
  PromoteVfsToCloudContainerRequest,
  PromoteVfsToCloudContainerResponse,
} from "@elizaos/shared";
import {
  PostWorkbenchVfsCompilePluginRequestSchema,
  PostWorkbenchVfsLoadPluginRequestSchema,
  PostWorkbenchVfsProjectRequestSchema,
  PostWorkbenchVfsPromoteToCloudRequestSchema,
  PostWorkbenchVfsRollbackRequestSchema,
  PostWorkbenchVfsSnapshotRequestSchema,
  PutWorkbenchVfsFileRequestSchema,
} from "@elizaos/shared";
import {
  getLoadedVfsPluginViews,
  loadPluginFromVfs,
  unloadPluginFromVfs,
} from "../runtime/load-plugin-from-vfs.ts";
import {
  createPluginCompiler,
  type PluginCompilerFormat,
} from "../services/plugin-compiler.ts";
import {
  createVirtualFilesystemService,
  VirtualFilesystemError,
  type VirtualFilesystemService,
  type VirtualFilesystemSnapshot,
} from "../services/virtual-filesystem.ts";
import type { WorkbenchRouteContext } from "./workbench-routes.ts";

export async function handleWorkbenchVfsRoutes(
  ctx: WorkbenchRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, url, json, error, readJsonBody } = ctx;

  if (method === "GET" && pathname === "/api/workbench/vfs/plugins") {
    json(res, { plugins: getLoadedVfsPluginViews() });
    return true;
  }

  if (method === "POST" && pathname === "/api/workbench/vfs/projects") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return true;
    const parsed = PostWorkbenchVfsProjectRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "projectId is required",
        400,
      );
      return true;
    }
    try {
      const vfs = await openProject(parsed.data.projectId);
      json(
        res,
        {
          project: projectView(vfs),
          quota: await vfs.quota(),
        },
        201,
      );
    } catch (err) {
      sendVfsError(ctx, err);
    }
    return true;
  }

  const match =
    /^\/api\/workbench\/vfs\/projects\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(
      pathname,
    );
  if (!match) return false;

  const projectId = ctx.decodePathComponent(match[1], res, "VFS project id");
  if (!projectId) return true;
  const section = match[2] ?? "";
  const tail = match[3] ?? "";

  try {
    const vfs = await openProject(projectId);

    if (method === "GET" && section === "quota") {
      json(res, { quota: await vfs.quota() });
      return true;
    }

    if (section === "files") {
      if (method !== "GET") {
        error(res, "Unsupported VFS files method", 405);
        return true;
      }
      await handleFiles(ctx, vfs);
      return true;
    }

    if (section === "file") {
      await handleFile(ctx, vfs);
      return true;
    }

    if (section === "snapshots") {
      await handleSnapshots(ctx, vfs, tail);
      return true;
    }

    if (method === "GET" && section === "diff") {
      const before = url.searchParams.get("beforeSnapshotId");
      const after = url.searchParams.get("afterSnapshotId");
      const snapshotId = url.searchParams.get("snapshotId");
      if (before && after) {
        json(res, { diff: await vfs.diffSnapshots(before, after) });
        return true;
      }
      if (!snapshotId) {
        error(res, "snapshotId is required", 400);
        return true;
      }
      json(res, { diff: await vfs.diffCurrent(snapshotId) });
      return true;
    }

    if (method === "POST" && section === "rollback") {
      const raw = await readJsonBody<Record<string, unknown>>(req, res);
      if (raw === null) return true;
      const parsed = PostWorkbenchVfsRollbackRequestSchema.safeParse(raw);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "snapshotId is required",
          400,
        );
        return true;
      }
      json(res, { rollback: await vfs.rollback(parsed.data.snapshotId) });
      return true;
    }

    if (method === "POST" && section === "compile-plugin") {
      if (!isLocalCodeExecutionAllowed()) {
        error(
          res,
          buildStoreVariantBlockedMessage("VFS plugin compilation"),
          403,
        );
        return true;
      }
      const raw = await readJsonBody<Record<string, unknown>>(req, res);
      if (raw === null) return true;
      const parsed = PostWorkbenchVfsCompilePluginRequestSchema.safeParse(raw);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "Invalid compile request",
          400,
        );
        return true;
      }
      const compiler = createPluginCompiler();
      const result = await compiler.compile({
        vfs,
        projectId,
        entry: parsed.data.entry,
        ...(parsed.data.outFile ? { outFile: parsed.data.outFile } : {}),
        ...(parsed.data.format
          ? { format: parsed.data.format as PluginCompilerFormat }
          : {}),
        ...(parsed.data.target ? { target: parsed.data.target } : {}),
      });
      json(res, { compile: result });
      return true;
    }

    if (method === "POST" && section === "load-plugin") {
      if (!isLocalCodeExecutionAllowed()) {
        error(res, buildStoreVariantBlockedMessage("VFS plugin loading"), 403);
        return true;
      }
      if (!ctx.state.runtime) {
        error(res, "Agent runtime is not available", 503);
        return true;
      }
      const raw = await readJsonBody<Record<string, unknown>>(req, res);
      if (raw === null) return true;
      const parsed = PostWorkbenchVfsLoadPluginRequestSchema.safeParse(raw);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "Invalid load request",
          400,
        );
        return true;
      }
      const result = await loadPluginFromVfs({
        runtime: ctx.state.runtime as AgentRuntime,
        vfs,
        projectId,
        entry: parsed.data.entry,
        ...(parsed.data.outFile ? { outFile: parsed.data.outFile } : {}),
        ...(typeof parsed.data.compileFirst === "boolean"
          ? { compileFirst: parsed.data.compileFirst }
          : {}),
      });
      json(res, result);
      return true;
    }

    if (method === "DELETE" && section === "plugins" && tail) {
      if (!isLocalCodeExecutionAllowed()) {
        error(
          res,
          buildStoreVariantBlockedMessage("VFS plugin unloading"),
          403,
        );
        return true;
      }
      if (!ctx.state.runtime) {
        error(res, "Agent runtime is not available", 503);
        return true;
      }
      const pluginName = ctx.decodePathComponent(tail, res, "plugin name");
      if (!pluginName) return true;
      json(
        res,
        await unloadPluginFromVfs({
          runtime: ctx.state.runtime as AgentRuntime,
          pluginName,
        }),
      );
      return true;
    }

    if (method === "POST" && section === "promote-to-cloud") {
      if (!ctx.state.runtime) {
        error(res, "Agent runtime is not available", 503);
        return true;
      }
      const cloud = getCloudCodingContainerService(ctx.state.runtime);
      if (!cloud) {
        error(res, "Cloud coding-container service is not available", 503);
        return true;
      }
      const raw = await readJsonBody<Record<string, unknown>>(req, res);
      if (raw === null) return true;
      const parsed = PostWorkbenchVfsPromoteToCloudRequestSchema.safeParse(raw);
      if (!parsed.success) {
        error(
          res,
          parsed.error.issues[0]?.message ?? "Invalid cloud promotion request",
          400,
        );
        return true;
      }
      const bundle = await exportVfsBundle(
        vfs,
        projectId,
        parsed.data.snapshotId,
      );
      const request: PromoteVfsToCloudContainerRequest = {
        source: bundle,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.description
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.preferredAgent
          ? { preferredAgent: parsed.data.preferredAgent }
          : {}),
        ...(parsed.data.workspacePath || parsed.data.branchName
          ? {
              target: {
                ...(parsed.data.workspacePath
                  ? { workspacePath: parsed.data.workspacePath }
                  : {}),
                ...(parsed.data.branchName
                  ? { branchName: parsed.data.branchName }
                  : {}),
              },
            }
          : {}),
        ...(parsed.data.metadata ? { metadata: parsed.data.metadata } : {}),
      };
      try {
        json(res, await cloud.promoteVfsToCloudContainer(request), 202);
      } catch (err) {
        const status =
          typeof (err as { statusCode?: unknown })?.statusCode === "number"
            ? (err as { statusCode: number }).statusCode
            : 500;
        error(res, err instanceof Error ? err.message : String(err), status);
      }
      return true;
    }

    error(res, "VFS route not found", 404);
    return true;
  } catch (err) {
    sendVfsError(ctx, err);
    return true;
  }
}

async function handleFiles(
  ctx: WorkbenchRouteContext,
  vfs: VirtualFilesystemService,
): Promise<void> {
  const path = ctx.url.searchParams.get("path") ?? ".";
  const recursive = ctx.url.searchParams.get("recursive") === "true";
  ctx.json(ctx.res, { files: await vfs.list(path, { recursive }) });
}

async function handleFile(
  ctx: WorkbenchRouteContext,
  vfs: VirtualFilesystemService,
): Promise<void> {
  const { req, res, method, url, json, error, readJsonBody } = ctx;
  const queryPath = url.searchParams.get("path");
  if (method !== "PUT" && !queryPath) {
    error(res, "path query parameter is required", 400);
    return;
  }

  if (method === "GET") {
    const encoding =
      url.searchParams.get("encoding") === "base64" ? "base64" : "utf-8";
    if (encoding === "base64") {
      const bytes = await vfs.readFileBytes(queryPath ?? "");
      json(res, {
        path: vfs.resolveVirtualPath(queryPath ?? ""),
        encoding,
        content: Buffer.from(bytes).toString("base64"),
      });
      return;
    }
    json(res, {
      path: vfs.resolveVirtualPath(queryPath ?? ""),
      encoding,
      content: await vfs.readFile(queryPath ?? ""),
    });
    return;
  }

  if (method === "PUT") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return;
    const parsed = PutWorkbenchVfsFileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid file request",
        400,
      );
      return;
    }
    const data =
      parsed.data.encoding === "base64"
        ? Buffer.from(parsed.data.content, "base64")
        : parsed.data.content;
    json(res, { file: await vfs.writeFile(parsed.data.path, data) });
    return;
  }

  if (method === "DELETE") {
    await vfs.delete(queryPath ?? "", { recursive: true });
    json(res, { ok: true });
    return;
  }

  error(res, "Unsupported VFS file method", 405);
}

async function handleSnapshots(
  ctx: WorkbenchRouteContext,
  vfs: VirtualFilesystemService,
  snapshotId: string,
): Promise<void> {
  const { req, res, method, json, error, readJsonBody } = ctx;

  if (method === "GET" && snapshotId) {
    const decoded = ctx.decodePathComponent(snapshotId, res, "snapshot id");
    if (!decoded) return;
    json(res, { snapshot: snapshotView(await vfs.getSnapshot(decoded)) });
    return;
  }

  if (method === "GET") {
    json(res, { snapshots: (await vfs.listSnapshots()).map(snapshotView) });
    return;
  }

  if (method === "POST") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return;
    const parsed = PostWorkbenchVfsSnapshotRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid snapshot request",
        400,
      );
      return;
    }
    json(
      res,
      { snapshot: snapshotView(await vfs.createSnapshot(parsed.data.note)) },
      201,
    );
    return;
  }

  error(res, "Unsupported VFS snapshot method", 405);
}

async function openProject(
  projectId: string,
): Promise<VirtualFilesystemService> {
  const vfs = createVirtualFilesystemService({ projectId });
  await vfs.initialize();
  return vfs;
}

function projectView(vfs: VirtualFilesystemService) {
  return {
    projectId: vfs.projectId,
  };
}

function snapshotView(snapshot: VirtualFilesystemSnapshot) {
  const { root: _root, ...view } = snapshot;
  return view;
}

function sendVfsError(ctx: WorkbenchRouteContext, err: unknown): void {
  if (err instanceof VirtualFilesystemError) {
    const status =
      err.code === "NOT_FOUND" || err.code === "SNAPSHOT_NOT_FOUND"
        ? 404
        : err.code === "QUOTA_EXCEEDED"
          ? 413
          : 400;
    ctx.error(ctx.res, err.message, status);
    return;
  }
  ctx.error(ctx.res, err instanceof Error ? err.message : String(err), 500);
}

interface CloudCodingContainerServiceLike {
  promoteVfsToCloudContainer(
    request: PromoteVfsToCloudContainerRequest,
  ): Promise<PromoteVfsToCloudContainerResponse>;
}

function getCloudCodingContainerService(
  runtime: AgentRuntime,
): CloudCodingContainerServiceLike | null {
  const service =
    runtime.getService?.("CLOUD_CONTAINER") ??
    runtime.getService?.("cloud-container") ??
    runtime.getService?.("cloudContainer");
  if (!service || typeof service !== "object") return null;
  const candidate = service as Partial<CloudCodingContainerServiceLike>;
  return typeof candidate.promoteVfsToCloudContainer === "function"
    ? (candidate as CloudCodingContainerServiceLike)
    : null;
}

async function exportVfsBundle(
  vfs: VirtualFilesystemService,
  projectId: string,
  snapshotId?: string,
): Promise<CloudVfsBundle> {
  const snapshot = snapshotId
    ? await vfs.getSnapshot(snapshotId)
    : await vfs.createSnapshot("promote-to-cloud");
  const entries = await vfs.exportFiles(snapshot.id);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const bytes = entry.bytes;
      return {
        path: entry.path,
        contents: Buffer.from(bytes).toString("base64"),
        encoding: "base64" as const,
        size: bytes.byteLength,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        mtimeMs: entry.mtimeMs,
      };
    }),
  );
  const totalBytes = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  return {
    sourceKind: "project",
    projectId,
    snapshotId: snapshot.id,
    revision: snapshot.id,
    files,
    manifest: {
      fileCount: files.length,
      totalBytes,
    },
  };
}
