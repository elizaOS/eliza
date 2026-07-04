/** Tests for the FILE `write` handler over the real filesystem, including the writability guard and secret detection. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type FileWriteTextParams,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { writeFileHandler } from "./write.js";

function unavailableCapability(
  capability: "fs" | "pty" | "git" | "model",
  method: string,
): never {
  throw new CapabilityError({
    code: "CAPABILITY_UNAVAILABLE",
    message: `${capability} unavailable`,
    capability,
    method,
  });
}

function makeWriteRouter(
  writeText: ElizaCapabilityRouter["fs"]["writeText"],
): ElizaCapabilityRouter {
  return {
    environment: "desktop",
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
    fs: {
      list: async () => unavailableCapability("fs", "fs.list"),
      readText: async () => unavailableCapability("fs", "fs.readText"),
      writeText,
    },
    pty: {
      runCommand: async () => unavailableCapability("pty", "pty.command.run"),
    },
    git: {
      status: async () => unavailableCapability("git", "git.status"),
      diff: async () => unavailableCapability("git", "git.diff"),
      commandRun: async () => unavailableCapability("git", "git.command.run"),
    },
    model: {
      status: async () => unavailableCapability("model", "model.status"),
    },
    plugin: new UnavailableCapabilityRouter("desktop").plugin,
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

  it("allows overwriting after a previous recordRead with matching mtime", async () => {
    const file = path.join(env.tmpDir, "tracked.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, content: "fresh" },
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

  it("rejects relative paths", async () => {
    const result = await writeFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "rel/path.txt", content: "x" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
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
