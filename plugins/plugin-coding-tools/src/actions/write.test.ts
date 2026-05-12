import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { writeFileHandler } from "./write.js";

describe("WRITE", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("write-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("creates a new file and its parent directory", async () => {
    const file = path.join(env.tmpDir, "nested", "deeper", "out.txt");
    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: file, content: "hello world" },
      },
    );

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("hello world");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.bytes).toBe(11);
  });

  it("rejects writes to existing files that were not READ first (must_read_first)", async () => {
    const file = path.join(env.tmpDir, "preexisting.txt");
    await fs.writeFile(file, "original", "utf8");

    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: file, content: "overwrite" },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("not read in this session");
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("original");
  });

  it("allows overwriting after a previous recordRead with matching mtime", async () => {
    const file = path.join(env.tmpDir, "tracked.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: file, content: "fresh" },
      },
    );

    expect(result.success).toBe(true);
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).toBe("fresh");
  });

  it("rejects stale reads when the file was modified externally", async () => {
    const file = path.join(env.tmpDir, "stale.txt");
    await fs.writeFile(file, "original", "utf8");
    await env.fileState.recordRead("test-room", file);

    // bump mtime
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(file, "external edit", "utf8");

    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: file, content: "agent overwrite" },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("stale_read");
  });

  it("refuses to write content containing detected secret patterns", async () => {
    const file = path.join(env.tmpDir, "secret.txt");
    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          file_path: file,
          content: "AKIAABCDEFGHIJKLMNOP",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("aws_access_key");
    await expect(fs.access(file)).rejects.toBeDefined();
  });

  it("rejects relative paths", async () => {
    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: "rel/path.txt", content: "x" },
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects paths under the blocklist", async () => {
    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          file_path: path.join(env.blockedPath, "x.txt"),
          content: "x",
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails when content param is missing", async () => {
    const result = await writeFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: path.join(env.tmpDir, "x.txt") },
      },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
