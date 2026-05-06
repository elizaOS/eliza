/**
 * Wave 1.B tool tests. These exercise the *inline* tool surface — bash,
 * file ops, ignore, path safety, and a mocked memory runtime.
 *
 * SHELL_ALLOWED_DIRECTORY is overridden to a per-suite tmpdir so tests don't
 * touch /workspace.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as bashMod from "../tools/bash.js";
import {
  editFileHandler,
  readFileHandler,
  writeFileHandler,
} from "../tools/file_ops.js";
import * as ignoreMod from "../tools/ignore.js";
import { recallHandler, rememberHandler } from "../tools/memory.js";
import { buildDefaultRegistry } from "../tools/registry.js";

let TMPDIR: string;
let prevAllowed: string | undefined;

beforeAll(async () => {
  TMPDIR = await fs.mkdtemp(path.join(os.tmpdir(), "nyx-tools-"));
  prevAllowed = process.env.SHELL_ALLOWED_DIRECTORY;
  process.env.SHELL_ALLOWED_DIRECTORY = TMPDIR;
});

afterAll(async () => {
  if (prevAllowed === undefined) delete process.env.SHELL_ALLOWED_DIRECTORY;
  else process.env.SHELL_ALLOWED_DIRECTORY = prevAllowed;
  await fs.rm(TMPDIR, { recursive: true, force: true });
});

const fakeRuntime = (): IAgentRuntime => ({}) as unknown as IAgentRuntime;
const fakeMessage = (): Memory => ({}) as unknown as Memory;

/* ──────────────────────────────────────────────────────────────────── */

describe("bash tool", () => {
  it("echoes a string back via /bin/sh", async () => {
    const res = await bashMod.handler(
      { command: "echo hello-nyx" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("hello-nyx");
  });

  it("captures non-zero exit and stderr", async () => {
    const res = await bashMod.handler(
      { command: "echo oops 1>&2; exit 3" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("exit 3");
    expect(res.content).toContain("oops");
  });

  it("rejects rm -rf / and similar footguns", async () => {
    const res = await bashMod.handler(
      { command: "rm -rf /" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/refused/i);
  });

  it("rejects cwd escapes", async () => {
    const res = await bashMod.handler(
      { command: "echo x", cwd: "../etc" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/cwd|outside|\.\./);
  });
});

/* ──────────────────────────────────────────────────────────────────── */

describe("file_ops", () => {
  it("write_file -> read_file roundtrip", async () => {
    const w = await writeFileHandler(
      { path: "hello.txt", content: "alpha\nbeta\ngamma\n" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(w.is_error).toBeFalsy();

    const r = await readFileHandler(
      { path: "hello.txt" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(r.is_error).toBeFalsy();
    expect(r.content).toBe("alpha\nbeta\ngamma\n");

    const paged = await readFileHandler(
      { path: "hello.txt", offset: 1, limit: 1 },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(paged.content).toBe("beta");
  });

  it("edit_file replaces a unique substring", async () => {
    await writeFileHandler(
      { path: "edit.txt", content: "the quick brown fox\n" },
      fakeRuntime(),
      fakeMessage(),
    );
    const e = await editFileHandler(
      { path: "edit.txt", old_string: "brown", new_string: "purple" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(e.is_error).toBeFalsy();
    const r = await readFileHandler(
      { path: "edit.txt" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(r.content).toContain("purple fox");
  });

  it("edit_file errors when needle appears multiple times", async () => {
    await writeFileHandler(
      { path: "dup.txt", content: "ab ab ab\n" },
      fakeRuntime(),
      fakeMessage(),
    );
    const e = await editFileHandler(
      { path: "dup.txt", old_string: "ab", new_string: "ZZ" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(e.is_error).toBe(true);
    expect(e.content).toMatch(/not unique/);
  });

  it("edit_file errors when needle is missing", async () => {
    await writeFileHandler(
      { path: "miss.txt", content: "nothing here\n" },
      fakeRuntime(),
      fakeMessage(),
    );
    const e = await editFileHandler(
      { path: "miss.txt", old_string: "ghost", new_string: "Z" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(e.is_error).toBe(true);
    expect(e.content).toMatch(/not found/);
  });

  it("rejects ../ escapes from any path-bearing tool", async () => {
    const r = await readFileHandler(
      { path: "../../etc/passwd" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/\.\.|outside/);

    const w = await writeFileHandler(
      { path: "/etc/passwd", content: "no" },
      fakeRuntime(),
      fakeMessage(),
    );
    expect(w.is_error).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */

describe("ignore tool", () => {
  it("returns the expected sentinel result", async () => {
    const res = await ignoreMod.handler({}, fakeRuntime(), fakeMessage());
    expect(res.is_error).toBeFalsy();
    expect(res.content).toBe("ignored");
  });

  it("is wired into the default registry", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("ignore")).toBe(true);
    expect(reg.get("ignore")?.tool.name).toBe("ignore");
  });
});

/* ──────────────────────────────────────────────────────────────────── */

describe("memory tools (mocked runtime)", () => {
  it("recall calls searchMemories with an embedding from useModel", async () => {
    const searchMemories = vi.fn().mockResolvedValue([
      {
        id: "m1",
        content: { text: "remembered fact about wakesync" },
        createdAt: Date.now(),
      },
    ]);
    const useModel = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const runtime = {
      agentId: "agent-1",
      useModel,
      searchMemories,
    } as unknown as IAgentRuntime;
    const message = { roomId: "room-1" } as unknown as Memory;

    const res = await recallHandler({ query: "wakesync" }, runtime, message);
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("wakesync");
    expect(useModel).toHaveBeenCalledWith("TEXT_EMBEDDING", {
      text: "wakesync",
    });
    expect(searchMemories).toHaveBeenCalledTimes(1);
    const args = searchMemories.mock.calls[0][0];
    expect(args.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(args.tableName).toBe("messages");
    expect(args.roomId).toBe("room-1");
  });

  it("remember calls runtime.createMemory and returns the id", async () => {
    const createMemory = vi.fn().mockResolvedValue("mem-uuid-123");
    const runtime = {
      agentId: "agent-1",
      createMemory,
    } as unknown as IAgentRuntime;
    const message = {
      roomId: "room-1",
      entityId: "user-1",
    } as unknown as Memory;

    const res = await rememberHandler(
      { text: "shadow prefers bun", category: "preference" },
      runtime,
      message,
    );
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("mem-uuid-123");
    expect(res.content).toContain("preference");
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [memArg, tableArg] = createMemory.mock.calls[0];
    expect(memArg.content.text).toBe("shadow prefers bun");
    expect(memArg.roomId).toBe("room-1");
    expect(tableArg).toBe("facts");
  });

  it("recall surfaces an error when no embedding model is registered", async () => {
    const runtime = {
      agentId: "a",
      searchMemories: vi.fn(),
    } as unknown as IAgentRuntime;
    const res = await recallHandler({ query: "x" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/embedding/);
  });
});

/* ──────────────────────────────────────────────────────────────────── */

describe("registry", () => {
  it("includes safe-by-default tools", () => {
    const reg = buildDefaultRegistry();
    const expected = [
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "recall",
      "remember",
      "ignore",
    ];
    for (const name of expected) expect(reg.has(name)).toBe(true);
    expect(reg.has("bash")).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────── */

// Sanity check: confirm the test environment actually has `sh` available.
describe("environment sanity", () => {
  it("sh is on PATH", () => {
    const r = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
});
