/** Tests for the FILE `edit` handler over the real filesystem, including the read-before-write staleness guard. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type IAgentRuntime,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { editFileHandler } from "./edit.js";

describe("EDIT", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("edit-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function seedFile(name: string, content: string): Promise<string> {
    const file = path.join(env.tmpDir, name);
    await fs.writeFile(file, content, "utf8");
    await env.fileState.recordRead("test-room", file);
    return file;
  }

  it("replaces a unique substring and reports the line number", async () => {
    const file = await seedFile("a.txt", "line one\nfoo bar\nline three");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "foo bar",
        new_string: "BAZ",
      },
    });

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("line one\nBAZ\nline three");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.replacements).toBe(1);
    expect(data?.firstLine).toBe(2);
    expect(data?.addedLines).toBe(1);
    expect(data?.removedLines).toBe(1);
  });

  it("keeps edit plugin-owned until fs.patch parity exists", async () => {
    const file = await seedFile("routed.txt", "alpha\nbeta\ngamma");
    const guardedRuntime = {
      ...env.runtime,
      getService: <T>(serviceType: string): T | null => {
        if (serviceType === CAPABILITY_ROUTER_SERVICE_TYPE) {
          throw new Error("edit must not use the capability router yet");
        }
        return env.runtime.getService<T>(serviceType);
      },
    } as IAgentRuntime;

    const result = await editFileHandler(
      guardedRuntime,
      env.message,
      undefined,
      {
        parameters: {
          file_path: file,
          old_string: "beta",
          new_string: "BETA",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("alpha\nBETA\ngamma");
  });

  it("fails on no_match when old_string isn't in the file", async () => {
    const file = await seedFile("b.txt", "the quick brown fox");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "zebra",
        new_string: "lion",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("no_match");
  });

  it("rejects ambiguous matches when replace_all is false", async () => {
    const file = await seedFile("c.txt", "alpha alpha alpha");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "alpha",
        new_string: "beta",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("ambiguous");
    expect(result.text).toContain("3 matches");
  });

  it("replaces every occurrence with replace_all=true", async () => {
    const file = await seedFile("d.txt", "x x x");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "x",
        new_string: "Y",
        replace_all: true,
      },
    });

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("Y Y Y");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.replacements).toBe(3);
  });

  it("rejects identical old_string and new_string", async () => {
    const file = await seedFile("e.txt", "same content");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "same",
        new_string: "same",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("identical");
  });

  it("refuses edits that introduce a detected secret", async () => {
    const file = await seedFile("f.txt", "API_KEY = REPLACE_ME");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "REPLACE_ME",
        new_string: "AKIAABCDEFGHIJKLMNOP",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("aws_access_key");
  });

  it("requires a prior READ (must_read_first)", async () => {
    const file = path.join(env.tmpDir, "no-read.txt");
    await fs.writeFile(file, "content here", "utf8");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "content",
        new_string: "stuff",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("not read in this session");
  });

  it("fails on stale_read when the file was modified externally", async () => {
    const file = await seedFile("g.txt", "first");
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(file, "external edit", "utf8");

    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "external",
        new_string: "internal",
      },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("stale_read");
  });

  it("rejects paths under the blocklist", async () => {
    const file = path.join(env.blockedPath, "x.txt");
    await fs.writeFile(file, "hello");
    const result = await editFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        old_string: "hello",
        new_string: "world",
      },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });
});
