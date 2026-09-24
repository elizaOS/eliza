/** Tests for the FILE `ls` handler over the real filesystem. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type FileListParams,
  type IAgentRuntime,
  type Memory,
  type State,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { lsHandler } from "./ls.js";

let tmpRoot: string;
let env: TestEnv;
let blockedPath: string;

function makeListRouter(
  list: ElizaCapabilityRouter["fs"]["list"],
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
      },
    }),
    fs: { ...router.fs, list },
  };
}

beforeEach(async () => {
  env = await setupEnv("ct-ls");
  tmpRoot = env.tmpDir;
  blockedPath = env.blockedPath;
  env.sessionCwd.setCwd("test-room", tmpRoot);
  const fooDir = path.join(tmpRoot, "foo");
  const barDir = path.join(tmpRoot, "bar");
  await fs.mkdir(fooDir, { recursive: true });
  await fs.mkdir(barDir, { recursive: true });
  await fs.writeFile(path.join(tmpRoot, "alpha.ts"), "alpha\n");
  await fs.writeFile(path.join(tmpRoot, "beta.md"), "beta\n");
  await fs.writeFile(path.join(tmpRoot, "skip.log"), "noise\n");
});

afterEach(async () => {
  await env.cleanup();
});

const state: State | undefined = undefined;

describe("LS", () => {
  it("lists fixture entries with directories first then files (sorted)", async () => {
    const { runtime, message } = env;
    const callback = vi.fn();
    const result = await lsHandler(
      runtime,
      message,
      state,
      {
        parameters: {},
      },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.data?.entries).toEqual([
      { name: "_blocked", type: "dir" },
      { name: "bar", type: "dir" },
      { name: "foo", type: "dir" },
      { name: "alpha.ts", type: "file", size: 6 },
      { name: "beta.md", type: "file", size: 5 },
      { name: "skip.log", type: "file", size: 6 },
    ]);

    expect(
      result.text.startsWith(
        "Scope: one directory level only (not recursive).\nDirectory:",
      ),
    ).toBe(true);
    expect(result.text).toContain("bar/");
    expect(result.text).toContain("foo/");
    expect(result.text).toContain("alpha.ts");
  });

  it("prefers capability router for directory listings when available", async () => {
    const calls: FileListParams[] = [];
    const router = makeListRouter(async (params) => {
      calls.push(params);
      return {
        root: { id: "workspace", path: tmpRoot },
        path: params.path ?? tmpRoot,
        entries: [
          {
            path: path.join(tmpRoot, "foo"),
            name: "foo",
            kind: "directory",
            size: 96,
          },
          {
            path: path.join(tmpRoot, "routed.ts"),
            name: "routed.ts",
            kind: "file",
            size: 12,
            isText: true,
          },
        ],
        truncated: false,
        totalAfterIgnore: 2,
      };
    });
    const { message } = env;
    const runtime = {
      ...env.runtime,
      getService: <T>(key: string): T | null =>
        key === CAPABILITY_ROUTER_SERVICE_TYPE
          ? (router as T)
          : env.runtime.getService<T>(key),
    } as IAgentRuntime;
    const callback = vi.fn();
    const result = await lsHandler(
      runtime,
      message,
      state,
      {
        parameters: { ignore: ["*.log"] },
      },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      {
        path: tmpRoot,
        includeHidden: true,
        ignore: ["*.log"],
      },
    ]);
    const data = result.data as Record<string, unknown> | undefined;
    const entries = data?.entries as
      | { name: string; type: string }[]
      | undefined;
    expect(entries).toEqual([
      { name: "foo", type: "dir" },
      { name: "routed.ts", type: "file", size: 12 },
    ]);
    expect(
      result.text.startsWith(
        "Scope: one directory level only (not recursive).\nDirectory:",
      ),
    ).toBe(true);
    expect(result.text).toContain("foo/");
    expect(result.text).toContain("routed.ts");
    expect(result.text).not.toContain("beta.md");
  });

  it("respects the ignore glob list", async () => {
    const { runtime, message } = env;
    const result = await lsHandler(runtime, message, state, {
      parameters: { ignore: ["*.log"] },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const entries = data?.entries as { name: string }[] | undefined;
    const names = entries?.map((e) => e.name) ?? [];
    expect(names).not.toContain("skip.log");
    expect(names).toContain("alpha.ts");
    expect(names).toContain("beta.md");
  });

  it.each(["pattern", "glob"] as const)(
    "rejects unsupported %s filters without returning an unfiltered listing",
    async (filter) => {
      const { runtime, message } = env;
      const result = await lsHandler(runtime, message, state, {
        parameters: { [filter]: "*.ts" },
      });

      expect(result.success).toBe(false);
      expect(result.text).toContain("invalid_param");
      expect(result.text).toContain(
        "ls does not accept pattern or glob filters",
      );
      expect(result.text).toContain("FILE action=glob");
      expect(result.text).not.toContain("alpha.ts");
      expect(result.data).toBeUndefined();
    },
  );

  it("rejects a path under the blocklist", async () => {
    const { runtime, message } = env;
    const result = await lsHandler(runtime, message, state, {
      parameters: { path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when roomId is missing", async () => {
    const { runtime } = env;
    const result = await lsHandler(runtime, {} as Memory, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
