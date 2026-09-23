/** Tests for the FILE `ls` handler over the real filesystem. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
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

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { lsHandler } from "./ls.js";

let tmpRoot: string;
let blockedPath: string;

interface RuntimeBundle {
  runtime: IAgentRuntime;
  message: Memory;
}

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

async function buildRuntime(
  capabilityRouter?: ElizaCapabilityRouter,
): Promise<RuntimeBundle> {
  const settings: Record<string, unknown> = {
    CODING_TOOLS_BLOCKED_PATHS: blockedPath,
  };
  const runtimeSeed = {
    getSetting: (key: string) => settings[key],
    getService: <T>(): T | null => null,
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(runtimeSeed);
  const session = await SessionCwdService.start(runtimeSeed);
  session.setCwd("test-room", tmpRoot);

  const runtime = {
    getSetting: (key: string) => settings[key],
    getService: <T>(serviceType: string): T | null => {
      if (serviceType === CAPABILITY_ROUTER_SERVICE_TYPE && capabilityRouter) {
        return capabilityRouter as T;
      }
      if (serviceType === SANDBOX_SERVICE) return sandbox as T;
      if (serviceType === SESSION_CWD_SERVICE) return session as T;
      return null;
    },
  } as IAgentRuntime;

  const message = { roomId: "test-room" } as Memory;
  return { runtime, message };
}

beforeEach(async () => {
  tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "ct-ls-")),
  );
  blockedPath = path.join(tmpRoot, "_blocked");
  await fs.mkdir(blockedPath, { recursive: true });
  const fooDir = path.join(tmpRoot, "foo");
  const barDir = path.join(tmpRoot, "bar");
  await fs.mkdir(fooDir, { recursive: true });
  await fs.mkdir(barDir, { recursive: true });
  await fs.writeFile(path.join(tmpRoot, "alpha.ts"), "alpha\n");
  await fs.writeFile(path.join(tmpRoot, "beta.md"), "beta\n");
  await fs.writeFile(path.join(tmpRoot, "skip.log"), "noise\n");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const state: State | undefined = undefined;

describe("LS", () => {
  it("lists fixture entries with directories first then files (sorted)", async () => {
    const { runtime, message } = await buildRuntime();
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
    const { runtime, message } = await buildRuntime(router);
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
    const { runtime, message } = await buildRuntime();
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
      const { runtime, message } = await buildRuntime();
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
    const { runtime, message } = await buildRuntime();
    const result = await lsHandler(runtime, message, state, {
      parameters: { path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when roomId is missing", async () => {
    const { runtime } = await buildRuntime();
    const result = await lsHandler(runtime, {} as Memory, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
