/** Tests for the FILE `glob` handler over a real temp directory tree. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { globHandler, globToRegExp } from "./glob.js";

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
  const runtimeSeed = {
    getSetting: (key: string) => settings[key],
    getService: <T>(_type: string): T | null => null,
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(runtimeSeed);
  const session = await SessionCwdService.start(runtimeSeed);
  session.setCwd("test-room", tmpRoot);

  const runtime = {
    getSetting: (key: string) => settings[key],
    getService: <T>(serviceType: string): T | null => {
      if (serviceType === SANDBOX_SERVICE) return sandbox as T;
      if (serviceType === SESSION_CWD_SERVICE) return session as T;
      return null;
    },
  } as IAgentRuntime;

  const message = { roomId: "test-room" } as Memory;
  return { runtime, message };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ct-glob-"));
  blockedPath = path.join(tmpRoot, "_blocked");
  await fs.mkdir(blockedPath, { recursive: true });
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
    const result = await globHandler(runtime, message, state, {
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
    expect(result.text).toMatch(/^3 files\n/);
  });

  it("keeps glob plugin-owned until fs.glob parity exists", async () => {
    const { runtime, message } = await buildRuntime();
    const guardedRuntime = {
      ...runtime,
      getService: <T>(serviceType: string): T | null => {
        if (serviceType === CAPABILITY_ROUTER_SERVICE_TYPE) {
          throw new Error("glob must not use the capability router yet");
        }
        return runtime.getService<T>(serviceType);
      },
    } as IAgentRuntime;

    const result = await globHandler(guardedRuntime, message, state, {
      parameters: { pattern: "**/*.ts" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toMatch(/^3 files\n/);
  });

  it("rejects a relative path", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globHandler(runtime, message, state, {
      parameters: { pattern: "**/*.ts", path: "./foo" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects a path under the blocklist", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globHandler(runtime, message, state, {
      parameters: { pattern: "**/*", path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when roomId is missing", async () => {
    const { runtime } = await buildRuntime();
    const result = await globHandler(runtime, {} as Memory, state, {
      parameters: { pattern: "**/*.ts" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });

  it("fails when pattern is missing", async () => {
    const { runtime, message } = await buildRuntime();
    const result = await globHandler(runtime, message, state, {
      parameters: {},
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});

describe("globToRegExp (fallback matcher)", () => {
  it("mirrors native glob semantics per branch", () => {
    // `**/` spans directories, including zero of them.
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("deep/nested/a.ts")).toBe(true);
    // bare `**` spans everything.
    expect(globToRegExp("src/**").test("src/a/b/c.txt")).toBe(true);
    // single `*` never crosses a slash.
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false);
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    // `?` is exactly one non-slash char.
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("a?.ts").test("a/.ts")).toBe(false);
    // dots and regex specials are literal.
    expect(globToRegExp("a.ts").test("aXts")).toBe(false);
    expect(globToRegExp("a+(b).ts").test("a+(b).ts")).toBe(true);
    expect(globToRegExp("a+(b).ts").test("ab.ts")).toBe(false);
  });
});

describe("globHandler — read-only query stays silent", () => {
  // The contract this PR establishes: raw listings/matches reach the model via
  // the ActionResult and the user via the planner's final message. Posting each
  // exploratory call's dump spammed chat (#16589) — the callback must never fire.
  it("does not invoke the visible chat callback", async () => {
    const { runtime, message } = await buildRuntime();
    const callback = vi.fn();
    const result = await globHandler(
      runtime,
      message,
      undefined,
      { parameters: { pattern: "**/*.ts" } },
      callback,
    );
    expect(result.success).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });
});
