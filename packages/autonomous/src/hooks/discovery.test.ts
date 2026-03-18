/**
 * Hook Discovery — Unit Tests
 *
 * Tests for:
 * - Frontmatter parsing (valid, metadata JSON, missing delimiters, empty name, invalid JSON)
 * - Handler resolution (handler.ts, fallback chain, no handler)
 * - Discovery precedence (workspace > managed > bundled > extra)
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverHooks } from "./discovery";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Stub the managed dir (~/.eliza/hooks) to avoid picking up real hooks
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return {
    ...actual,
    // Point homedir to a temp location so ~/.eliza/hooks doesn't exist
    homedir: () => join(tmpdir(), "__discovery_test_fake_home__"),
  };
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let tempRoot: string;

async function createHookDir(
  base: string,
  name: string,
  opts: {
    hookMd?: string;
    handlerFile?: string; // which handler filename to create
    handlerContent?: string;
  } = {},
): Promise<string> {
  const dir = join(base, name);
  await mkdir(dir, { recursive: true });

  if (opts.hookMd !== undefined) {
    await writeFile(join(dir, "HOOK.md"), opts.hookMd, "utf-8");
  }

  const handlerFile = opts.handlerFile ?? "handler.ts";
  const handlerContent = opts.handlerContent ?? "export default () => {};";
  await writeFile(join(dir, handlerFile), handlerContent, "utf-8");

  return dir;
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempRoot = join(
    tmpdir(),
    `hooks-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tempRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

// ============================================================================
//  1. Frontmatter parsing (tested via discoverHooks)
// ============================================================================

describe("frontmatter parsing", () => {
  it("parses valid frontmatter with name and description", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "my-hook", {
      hookMd: [
        "---",
        "name: my-hook",
        "description: A test hook",
        "---",
        "",
        "# My Hook",
      ].join("\n"),
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].hook.name).toBe("my-hook");
    expect(entries[0].frontmatter.description).toBe("A test hook");
    expect(entries[0].hook.source).toBe("eliza-bundled");
  });

  it("extracts eliza metadata from frontmatter JSON", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "meta-hook", {
      hookMd: [
        "---",
        "name: meta-hook",
        "description: Hook with metadata",
        'metadata: { "eliza": { "emoji": "🔥", "events": ["command:new"], "hookKey": "custom-key" } }',
        "---",
      ].join("\n"),
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].metadata).toBeDefined();
    expect(entries[0].metadata?.emoji).toBe("🔥");
    expect(entries[0].metadata?.events).toEqual(["command:new"]);
    expect(entries[0].metadata?.hookKey).toBe("custom-key");
  });

  it("skips hook when frontmatter delimiters are missing", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "bad-fm", {
      hookMd: "name: no-delimiters\ndescription: missing ---\n",
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(0);
  });

  it("skips hook when name is empty", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "empty-name", {
      hookMd: [
        "---",
        "name: ",
        "description: Has description but no name",
        "---",
      ].join("\n"),
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(0);
  });

  it("warns but still parses name/description when metadata JSON is invalid", async () => {
    const { logger } = await import("@elizaos/core");
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "bad-meta", {
      hookMd: [
        "---",
        "name: bad-meta",
        "description: Invalid metadata JSON",
        "metadata: {not valid json!!!}",
        "---",
      ].join("\n"),
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].hook.name).toBe("bad-meta");
    expect(entries[0].frontmatter.description).toBe("Invalid metadata JSON");
    expect(entries[0].metadata).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse metadata"),
    );
  });

  it("parses homepage from frontmatter", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "hp-hook", {
      hookMd: [
        "---",
        "name: hp-hook",
        "description: Hook with homepage",
        "homepage: https://example.com",
        "---",
      ].join("\n"),
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].frontmatter.homepage).toBe("https://example.com");
  });
});

// ============================================================================
//  2. Handler resolution
// ============================================================================

describe("handler resolution", () => {
  it("uses handler.ts when found", async () => {
    const bundled = join(tempRoot, "bundled");
    await createHookDir(bundled, "ts-handler", {
      hookMd: "---\nname: ts-handler\ndescription: uses handler.ts\n---",
      handlerFile: "handler.ts",
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].hook.handlerPath).toContain("handler.ts");
  });

  it("falls back to index.ts when handler.ts is missing", async () => {
    const bundled = join(tempRoot, "bundled");
    const dir = join(bundled, "idx-hook");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "HOOK.md"),
      "---\nname: idx-hook\ndescription: uses index.ts\n---",
      "utf-8",
    );
    // Only create index.ts, no handler.ts or handler
    await writeFile(join(dir, "index.ts"), "export default () => {};", "utf-8");

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].hook.handlerPath).toContain("index.ts");
  });

  it("falls back to handler (no ext) when handler.ts is missing", async () => {
    const bundled = join(tempRoot, "bundled");
    const dir = join(bundled, "noext-hook");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "HOOK.md"),
      "---\nname: noext-hook\ndescription: uses handler (no ext)\n---",
      "utf-8",
    );
    await writeFile(join(dir, "handler"), "export default () => {};", "utf-8");

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(basename(entries[0].hook.handlerPath)).toBe("handler");
  });

  it("skips hook when no handler file exists", async () => {
    const { logger } = await import("@elizaos/core");
    const bundled = join(tempRoot, "bundled");
    const dir = join(bundled, "no-handler");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "HOOK.md"),
      "---\nname: no-handler\ndescription: missing handler\n---",
      "utf-8",
    );
    // No handler file at all

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no handler"),
    );
  });
});

// ============================================================================
//  3. Discovery precedence
// ============================================================================

describe("discovery precedence", () => {
  it("workspace hook overrides bundled hook with the same name", async () => {
    const bundled = join(tempRoot, "bundled");
    const workspace = join(tempRoot, "workspace");

    await createHookDir(bundled, "shared-hook", {
      hookMd: "---\nname: shared-hook\ndescription: bundled version\n---",
    });
    // workspace hooks live under <workspacePath>/hooks/
    const wsHooks = join(workspace, "hooks");
    await createHookDir(wsHooks, "shared-hook", {
      hookMd: "---\nname: shared-hook\ndescription: workspace version\n---",
    });

    const entries = await discoverHooks({
      bundledDir: bundled,
      workspacePath: workspace,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].frontmatter.description).toBe("workspace version");
    expect(entries[0].hook.source).toBe("eliza-workspace");
  });

  it("collects hooks from all sources when names are unique", async () => {
    const bundled = join(tempRoot, "bundled");
    const extra = join(tempRoot, "extra");

    await createHookDir(bundled, "hook-a", {
      hookMd: "---\nname: hook-a\ndescription: bundled\n---",
    });
    await createHookDir(extra, "hook-b", {
      hookMd: "---\nname: hook-b\ndescription: extra\n---",
    });

    const entries = await discoverHooks({
      bundledDir: bundled,
      extraDirs: [extra],
    });

    const names = entries.map((e) => e.hook.name).sort();
    expect(names).toEqual(["hook-a", "hook-b"]);
  });

  it("returns empty array for nonexistent directory", async () => {
    const entries = await discoverHooks({
      bundledDir: join(tempRoot, "does-not-exist"),
    });

    expect(entries).toEqual([]);
  });

  it("skips non-directory entries inside hooks dir", async () => {
    const bundled = join(tempRoot, "bundled");
    await mkdir(bundled, { recursive: true });
    // Create a file (not directory) inside the hooks dir
    await writeFile(join(bundled, "not-a-dir.txt"), "just a file", "utf-8");

    await createHookDir(bundled, "real-hook", {
      hookMd: "---\nname: real-hook\ndescription: a real hook\n---",
    });

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toHaveLength(1);
    expect(entries[0].hook.name).toBe("real-hook");
  });

  it("skips directories without HOOK.md", async () => {
    const bundled = join(tempRoot, "bundled");
    const dir = join(bundled, "no-hookmd");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "handler.ts"),
      "export default () => {};",
      "utf-8",
    );
    // No HOOK.md

    const entries = await discoverHooks({ bundledDir: bundled });

    expect(entries).toEqual([]);
  });
});
