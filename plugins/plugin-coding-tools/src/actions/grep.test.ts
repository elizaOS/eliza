/** Tests for the FILE `grep` handler driving RipgrepService over a real temp workspace. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type TestContext,
  vi,
} from "vitest";

import { RipgrepService } from "../services/ripgrep-service.js";
import { RIPGREP_SERVICE } from "../types.js";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { grepHandler } from "./grep.js";

let env: TestEnv;
let rg: RipgrepService;
let runtime: IAgentRuntime;
let tmpRoot: string;
let blockedPath: string;

function requireRipgrep(context: TestContext): void {
  const probe = spawnSync(rg.binary(), ["--version"], { stdio: "ignore" });
  if (probe.error && "code" in probe.error && probe.error.code === "ENOENT")
    context.skip("ripgrep executable is unavailable");
  expect(probe.error).toBeUndefined();
  expect(probe.status).toBe(0);
}

beforeEach(async () => {
  env = await setupEnv("ct-grep");
  tmpRoot = env.tmpDir;
  blockedPath = env.blockedPath;
  env.sessionCwd.setCwd("test-room", tmpRoot);
  rg = await RipgrepService.start(env.runtime);
  runtime = {
    ...env.runtime,
    getService: <T>(key: string): T | null =>
      key === RIPGREP_SERVICE ? (rg as T) : env.runtime.getService<T>(key),
  } as IAgentRuntime;
  const fooDir = path.join(tmpRoot, "foo");
  const subDir = path.join(fooDir, "sub");
  await fs.mkdir(subDir, { recursive: true });
  await fs.writeFile(path.join(fooDir, "a.ts"), "export const NEEDLE = 1;\n");
  await fs.writeFile(path.join(fooDir, "b.ts"), "// nothing matches here\n");
  await fs.writeFile(
    path.join(subDir, "c.ts"),
    "function needle() { return 'NEEDLE'; }\n",
  );
  await fs.writeFile(
    path.join(fooDir, "notes.md"),
    "Some markdown about NEEDLE.\n",
  );
});

afterEach(async () => {
  try {
    await rg.stop();
  } finally {
    await env.cleanup();
  }
});

const state: State | undefined = undefined;

describe("GREP", () => {
  it("returns matching files for a known token (default mode)", async (context) => {
    requireRipgrep(context);
    const { message } = env;

    const callback = vi.fn();
    const result = await grepHandler(
      runtime,
      message,
      state,
      {
        parameters: { pattern: "NEEDLE" },
      },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.mode).toBe("files_with_matches");
    expect(typeof data?.matches_count).toBe("number");
    expect((data?.matches_count as number) >= 2).toBe(true);
    expect(result.text).toContain("a.ts");
    expect(result.text).toContain("notes.md");
  });

  it("keeps search plugin-owned until fs.search parity exists", async (context) => {
    requireRipgrep(context);
    const { message } = env;
    const guardedRuntime = {
      ...runtime,
      getService: <T>(serviceType: string): T | null => {
        if (serviceType === CAPABILITY_ROUTER_SERVICE_TYPE) {
          throw new Error("grep must not use the capability router yet");
        }
        return runtime.getService<T>(serviceType);
      },
    } as IAgentRuntime;

    const result = await grepHandler(guardedRuntime, message, state, {
      parameters: { pattern: "NEEDLE" },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("a.ts");
  });

  it("matches case-insensitively when case_insensitive is true", async (context) => {
    requireRipgrep(context);
    const { message } = env;

    const sensitive = await grepHandler(runtime, message, state, {
      parameters: { pattern: "needle", output_mode: "files_with_matches" },
    });
    expect(sensitive.success).toBe(true);
    const sensitiveCount = (
      sensitive.data as Record<string, unknown> | undefined
    )?.matches_count as number;

    const insensitive = await grepHandler(runtime, message, state, {
      parameters: {
        pattern: "needle",
        output_mode: "files_with_matches",
        case_insensitive: true,
      },
    });
    expect(insensitive.success).toBe(true);
    const insensitiveCount = (
      insensitive.data as Record<string, unknown> | undefined
    )?.matches_count as number;

    expect(insensitiveCount).toBeGreaterThan(sensitiveCount);
  });

  it("rejects a path under the blocklist", async () => {
    const { message } = env;

    const result = await grepHandler(runtime, message, state, {
      parameters: { pattern: "NEEDLE", path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("returns 'no matches' for an unmatched pattern", async (context) => {
    requireRipgrep(context);
    const { message } = env;

    const callback = vi.fn();
    const result = await grepHandler(
      runtime,
      message,
      state,
      {
        parameters: { pattern: "ZZZ_DEFINITELY_NO_MATCH_ZZZ" },
      },
      callback,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.text).toBe("no matches");
    expect(
      (result.data as Record<string, unknown> | undefined)?.matches_count,
    ).toBe(0);
  });

  it("returns matches_count:0 for count mode on a zero-match pattern", async (context) => {
    requireRipgrep(context);
    const { message } = env;

    // ripgrep exits 1 on zero matches in EVERY mode; count mode must surface
    // that as a clean empty answer, not a fabricated command failure.
    const result = await grepHandler(runtime, message, state, {
      parameters: {
        pattern: "ZZZ_DEFINITELY_NO_MATCH_ZZZ",
        output_mode: "count",
      },
    });
    expect(result.success).toBe(true);
    expect(result.text).toBe("no matches");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.matches_count).toBe(0);
    expect(data?.mode).toBe("count");
    expect(data?.truncated).toBe(false);
    // A fabricated failure would have carried the command_failed prefix.
    expect(result.text).not.toContain("command_failed");
  });

  it("preserves per-file counts for count mode on a matching pattern", async (context) => {
    requireRipgrep(context);
    const { message } = env;

    const result = await grepHandler(runtime, message, state, {
      parameters: { pattern: "NEEDLE", output_mode: "count" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.mode).toBe("count");
    // The count output lists one `path:count` line per matching file; at least
    // a.ts and notes.md match, so the reported file count is >= 2.
    expect((data?.matches_count as number) >= 2).toBe(true);
    expect(result.text).toContain("a.ts");
    expect(result.text).toMatch(/a\.ts:\d+/);
  });

  it("fails when roomId is missing", async () => {
    const result = await grepHandler(runtime, {} as Memory, state, {
      parameters: { pattern: "NEEDLE" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
