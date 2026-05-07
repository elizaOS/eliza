import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { globAction } from "./glob.js";

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ct-glob-"));
  const fooDir = path.join(tmpRoot, "foo");
  const subDir = path.join(fooDir, "sub");
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(path.join(fooDir, "a.ts"), "export const A = 1;\n");
  await fs.writeFile(path.join(fooDir, "b.ts"), "export const B = 2;\n");
  await fs.writeFile(path.join(subDir, "c.ts"), "export const C = 3;\n");
  await fs.writeFile(path.join(fooDir, "notes.md"), "# notes\n");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const state: State | undefined = undefined;

describe("GLOB", () => {
  it("matches **/*.ts and returns expected count", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globAction.handler?.(runtime, message, state, {
      parameters: { pattern: "**/*.ts" },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    const files = data?.files as string[] | undefined;
    expect(Array.isArray(files)).toBe(true);
    expect(files?.length).toBe(3);
    const sortedNames = [...(files ?? [])].sort();
    expect(sortedNames.some((p) => p.endsWith("a.ts"))).toBe(true);
    expect(sortedNames.some((p) => p.endsWith("b.ts"))).toBe(true);
    expect(sortedNames.some((p) => p.endsWith("c.ts"))).toBe(true);
    expect(data?.truncated).toBe(false);
    expect(result.text).toMatch(/3 files \(truncated=false\)/);
  });

  it("rejects a relative path", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globAction.handler?.(runtime, message, state, {
      parameters: { pattern: "**/*.ts", path: "./foo" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects a path under the blocklist", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globAction.handler?.(runtime, message, state, {
      parameters: { pattern: "**/*", path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when roomId is missing", async () => {
    const { runtime } = await buildRuntime();
    const result = await globAction.handler?.(runtime, {} as Memory, state, {
      parameters: { pattern: "**/*.ts" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });

  it("fails when pattern is missing", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globAction.handler?.(runtime, message, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
