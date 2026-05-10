import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RipgrepService } from "../services/ripgrep-service.js";
import { SandboxService } from "../services/sandbox-service.js";
import { SessionCwdService } from "../services/session-cwd-service.js";
import {
  RIPGREP_SERVICE,
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
} from "../types.js";
import { grepAction } from "./grep.js";

function locateSystemRg(): string | undefined {
  const candidates = [
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    "/usr/bin/rg",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

let tmpRoot: string;
let blockedPath: string;

interface RuntimeBundle {
  runtime: IAgentRuntime;
  message: Memory;
}

async function buildRuntime(
  rootOverride?: string,
  settings: Record<string, unknown> = {},
): Promise<RuntimeBundle | null> {
  const root = rootOverride ?? tmpRoot;
  const mergedSettings = {
    CODING_TOOLS_BLOCKED_PATHS: blockedPath,
    ...settings,
  };
  const stub = {
    getSetting: (key: string) => mergedSettings[key],
    getService: <T>(_type: string): T | null => null,
  } as IAgentRuntime;

  const sandbox = await SandboxService.start(stub);
  const session = await SessionCwdService.start(stub);
  const rg = await RipgrepService.start(stub);

  // The bundled @vscode/ripgrep binary may be absent in dev installs; fall back
  // to a system rg if so. If neither works, skip the test.
  const initialBinary = rg.binary();
  if (!existsSync(initialBinary)) {
    const sysRg = locateSystemRg();
    if (!sysRg) {
      console.warn(
        `no usable ripgrep found (tried ${initialBinary} and system paths); skipping`,
      );
      return null;
    }
    (rg as { rgPath: string }).rgPath = sysRg;
  }

  session.setCwd("test-room", root);

  const runtime = {
    getSetting: (key: string) => mergedSettings[key],
    getService: <T>(serviceType: string): T | null => {
      if (serviceType === SANDBOX_SERVICE) return sandbox as T;
      if (serviceType === SESSION_CWD_SERVICE) return session as T;
      if (serviceType === RIPGREP_SERVICE) return rg as T;
      return null;
    },
  } as IAgentRuntime;

  const message = { roomId: "test-room" } as Memory;
  return { runtime, message };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ct-grep-"));
  blockedPath = path.join(tmpRoot, "_blocked");
  await fs.mkdir(blockedPath, { recursive: true });
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
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const state: State | undefined = undefined;

describe("GREP", () => {
  it("returns matching files for a known token (default mode)", async () => {
    const bundle = await buildRuntime();
    if (!bundle) {
      console.warn("no ripgrep available, skipping");
      return;
    }
    const { runtime, message } = bundle;

    const result = await grepAction.handler?.(runtime, message, state, {
      parameters: { pattern: "NEEDLE" },
    });

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.mode).toBe("files_with_matches");
    expect(typeof data?.matches_count).toBe("number");
    expect((data?.matches_count as number) >= 2).toBe(true);
    expect(result.text).toContain("a.ts");
    expect(result.text).toContain("notes.md");
  });

  it("matches case-insensitively when case_insensitive is true", async () => {
    const bundle = await buildRuntime();
    if (!bundle) {
      console.warn("no ripgrep available, skipping");
      return;
    }
    const { runtime, message } = bundle;

    const sensitive = await grepAction.handler?.(runtime, message, state, {
      parameters: { pattern: "needle", output_mode: "files_with_matches" },
    });
    expect(sensitive.success).toBe(true);
    const sensitiveCount = (
      sensitive.data as Record<string, unknown> | undefined
    )?.matches_count as number;

    const insensitive = await grepAction.handler?.(runtime, message, state, {
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
    const bundle = await buildRuntime();
    if (!bundle) {
      console.warn("no ripgrep available, skipping");
      return;
    }
    const { runtime, message } = bundle;

    const result = await grepAction.handler?.(runtime, message, state, {
      parameters: { pattern: "NEEDLE", path: blockedPath },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("returns 'no matches' for an unmatched pattern", async () => {
    const bundle = await buildRuntime();
    if (!bundle) {
      console.warn("no ripgrep available, skipping");
      return;
    }
    const { runtime, message } = bundle;

    const result = await grepAction.handler?.(runtime, message, state, {
      parameters: { pattern: "ZZZ_DEFINITELY_NO_MATCH_ZZZ" },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("no matches");
    expect(
      (result.data as Record<string, unknown> | undefined)?.matches_count,
    ).toBe(0);
  });

  it("fails when roomId is missing", async () => {
    const bundle = await buildRuntime();
    if (!bundle) {
      console.warn("no ripgrep available, skipping");
      return;
    }
    const { runtime } = bundle;
    const result = await grepAction.handler?.(runtime, {} as Memory, state, {
      parameters: { pattern: "NEEDLE" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
