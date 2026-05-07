import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { lsAction } from "./ls.js";

let tmpRoot: string;
let blockedPath: string;

interface RuntimeBundle {
  runtime: IAgentRuntime;
  message: Memory;
}

async function buildRuntime(): Promise<RuntimeBundle> {
  const settings: Record<string, unknown> = {
    CODING_TOOLS_BLOCKED_PATHS: blockedPath,
  };
  const stub = {
    getSetting: (key: string) => settings[key],
    getService: <T>(_type: string): T | null => null,
  } as unknown as IAgentRuntime;

  const sandbox = await SandboxService.start(stub);
  const session = await SessionCwdService.start(stub);
  session.setCwd("test-room", tmpRoot);

  const runtime = {
    getSetting: (key: string) => settings[key],
    getService: <T>(serviceType: string): T | null => {
      if (serviceType === SANDBOX_SERVICE) return sandbox as unknown as T;
      if (serviceType === SESSION_CWD_SERVICE) return session as unknown as T;
      return null;
    },
  } as unknown as IAgentRuntime;

  const message = { roomId: "test-room" } as unknown as Memory;
  return { runtime, message };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ct-ls-"));
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
    const result = await lsAction.handler?.(runtime, message, state, {
      parameters: {},
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const entries = data?.entries as
      | { name: string; type: string }[]
      | undefined;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries?.length).toBe(6);

    const types = entries?.map((e) => e.type) ?? [];
    const firstFileIndex = types.indexOf("file");
    const lastDirIndex = types.lastIndexOf("dir");
    expect(lastDirIndex).toBeLessThan(firstFileIndex);

    const dirNames = (entries ?? [])
      .filter((e) => e.type === "dir")
      .map((e) => e.name);
    expect(dirNames).toEqual(["_blocked", "bar", "foo"]);

    const fileNames = (entries ?? [])
      .filter((e) => e.type !== "dir")
      .map((e) => e.name);
    expect(fileNames).toEqual(["alpha.ts", "beta.md", "skip.log"]);

    expect(result.text).toContain("Directory:");
    expect(result.text).toContain("bar/");
    expect(result.text).toContain("foo/");
    expect(result.text).toContain("alpha.ts");
  });

  it("respects the ignore glob list", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await lsAction.handler?.(runtime, message, state, {
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

  it("rejects a path under the blocklist", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await lsAction.handler?.(runtime, message, state, {
      parameters: { path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when roomId is missing", async () => {
    const { runtime } = await buildRuntime();
    const result = await lsAction.handler?.(runtime, {} as Memory, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });

  it("includes file size for files in the entries data", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await lsAction.handler?.(runtime, message, state, {
      parameters: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const entries = data?.entries as
      | { name: string; type: string; size?: number }[]
      | undefined;
    const alpha = entries?.find((e) => e.name === "alpha.ts");
    expect(alpha?.type).toBe("file");
    expect(typeof alpha?.size).toBe("number");
  });
});
