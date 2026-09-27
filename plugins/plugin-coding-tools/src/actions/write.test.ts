/** Tests for the FILE `write` handler over the real filesystem, including the writability guard and secret detection. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type FileWriteTextParams,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEnv, type TestEnv } from "./__tests__/helpers.js";
import { writeFileHandler } from "./write.js";

function makeWriteRouter(
  writeText: ElizaCapabilityRouter["fs"]["writeText"],
): ElizaCapabilityRouter {
  const router = new UnavailableCapabilityRouter("desktop");
  return {
    ...router,
    availability: async () => ({
      environment: "desktop",
      available: true,
      capabilities: {
        fs: true,
        pty: false,
        git: false,
        model: false,
        plugin: false,
      },
    }),
    fs: { ...router.fs, writeText },
  };
}

function runtimeWithRouter(
  runtime: IAgentRuntime,
  router: ElizaCapabilityRouter,
): IAgentRuntime {
  return {
    ...runtime,
    getService: <T>(serviceType: string): T | null =>
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE
        ? (router as T)
        : runtime.getService<T>(serviceType),
  } as IAgentRuntime;
}

describe("WRITE", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("write-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("creates a new file and its parent directory", async () => {
    const file = path.join(env.tmpDir, "nested", "deeper", "out.txt");
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "hello world" },
    });

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("hello world");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.bytes).toBe(11);
    // The write confirmation is user-facing so the planner-loop relays it
    // verbatim when the post-tool evaluator model call fails (no regression on
    // the elizaOS Cloud 400 incident).
    expect(result.userFacingText).toBe(result.text);
    expect(result.userFacingText).toContain("Wrote 11 bytes to ");
  });

  it("prefers capability router for file writes when available", async () => {
    const file = path.join(env.tmpDir, "nested", "routed.txt");
    const calls: FileWriteTextParams[] = [];
    const router = makeWriteRouter(async (params) => {
      calls.push(params);
      await fs.mkdir(path.dirname(params.path), { recursive: true });
      await fs.writeFile(params.path, params.text, "utf8");
      return {
        path: params.path,
        bytesWritten: Buffer.byteLength(params.text, "utf8"),
      };
    });
    const result = await writeFileHandler(
      runtimeWithRouter(env.runtime, router),
      env.message,
      undefined,
      { parameters: { file_path: file, content: "routed write" } },
    );

    expect(result.success).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("routed write");
    expect(calls).toEqual([
      {
        path: file,
        text: "routed write",
        createDirectories: true,
        overwrite: true,
      },
    ]);
    const meta = env.fileState.get("test-room", file);
    expect(meta).toBeDefined();
  });

  it("accepts a path-translating provider that echoes the requested path", async () => {
    const file = path.join(env.tmpDir, "fresh.txt");
    // The sandbox workdir mirrors the host workspace; the provider reports
    // its mapped path plus the host path it was asked to write.
    const writeText = vi.fn(async (params: FileWriteTextParams) => {
      await fs.writeFile(params.path, params.text, "utf8");
      return {
        path: "/workspace/fresh.txt",
        requestedPath: params.path,
        bytesWritten: Buffer.byteLength(params.text, "utf8"),
      };
    });
    const result = await writeFileHandler(
      runtimeWithRouter(env.runtime, makeWriteRouter(writeText)),
      env.message,
      undefined,
      { parameters: { file_path: file, content: "hello" } },
      vi.fn(async () => []),
    );
    expect(result.success).toBe(true);
    expect(result.effectReceipts).toHaveLength(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider acknowledgment for another path without falling back or claiming no effect", async () => {
    const file = path.join(env.tmpDir, "requested.txt");
    const other = path.join(env.tmpDir, "different.txt");
    const writeText = vi.fn(async (params: FileWriteTextParams) => {
      await fs.writeFile(other, params.text, "utf8");
      return {
        path: other,
        bytesWritten: Buffer.byteLength(params.text, "utf8"),
      };
    });
    const callback = vi.fn(async () => []);
    const result = await writeFileHandler(
      runtimeWithRouter(env.runtime, makeWriteRouter(writeText)),
      env.message,
      undefined,
      { parameters: { file_path: file, content: "provider wrote elsewhere" } },
      callback,
    );
    expect(result.success).toBe(false);
    expect(result.effectReceipts).toBeUndefined();
    expect(result.failureProvenance).toMatchObject({
      kind: "persistence_error",
      code: "FILE_WRITE_UNVERIFIED",
      retryable: false,
    });
    expect(result.data).toMatchObject({ path: file, acceptance: "unknown" });
    expect(result.text).toContain("requested write outcome is unknown");
    expect(await fs.readFile(other, "utf8")).toBe("provider wrote elsewhere");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(env.fileState.get("test-room", file)).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("rejects writes to existing files that were not READ first (must_read_first)", async () => {
    const file = path.join(env.tmpDir, "preexisting.txt");
    await fs.writeFile(file, "original", "utf8");

    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "overwrite" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("not read in this session");
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("original");
  });

  it("requires explicit overwrite after a previous recordRead", async () => {
    const file = path.join(env.tmpDir, "tracked.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "fresh" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain(
      "WRITE would replace the entire existing file",
    );
    expect(await fs.readFile(file, "utf8")).toBe("original");
  });

  it("allows an explicit overwrite after a previous recordRead with matching mtime", async () => {
    const file = path.join(env.tmpDir, "tracked-overwrite.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "fresh", overwrite: true },
    });

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("fresh");
  });

  it("rejects stale reads when the file was modified externally", async () => {
    const file = path.join(env.tmpDir, "stale.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    // bump mtime
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(file, "external edit", "utf8");

    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "agent overwrite" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("stale_read");
  });

  it("refuses to write content containing detected secret patterns", async () => {
    const file = path.join(env.tmpDir, "secret.txt");
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        content: "AKIAABCDEFGHIJKLMNOP",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("aws_access_key");
    await expect(fs.access(file)).rejects.toBeDefined();
  });

  it("resolves relative paths against the session cwd", async () => {
    env.sessionCwd.setCwd("test-room", env.tmpDir);
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "rel/path.txt", content: "x" },
    });
    expect(result.success).toBe(true);
    const written = await fs.readFile(
      path.join(env.tmpDir, "rel/path.txt"),
      "utf8",
    );
    expect(written).toBe("x");
  });

  it("rejects paths under the blocklist", async () => {
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: path.join(env.blockedPath, "x.txt"),
        content: "x",
      },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when content param is missing", async () => {
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: path.join(env.tmpDir, "x.txt") },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
