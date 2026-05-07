import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAction } from "./read.js";
import { setupEnv, type TestEnv } from "./_test-helpers.js";

describe("READ", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("read-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reads a small file and returns numbered lines", async () => {
    const file = path.join(env.tmpDir, "hello.txt");
    await fs.writeFile(file, "line one\nline two\nline three", "utf8");

    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain(file);
    expect(result.text).toContain("\tline one");
    expect(result.text).toContain("\tline two");
    expect(result.text).toContain("\tline three");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.totalLines).toBe(3);
    expect(data?.lines).toBe(3);
  });

  it("right-pads line numbers to 6 chars and uses tab separator", async () => {
    const file = path.join(env.tmpDir, "lines.txt");
    await fs.writeFile(file, "alpha\nbeta", "utf8");

    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("     1\talpha");
    expect(result.text).toContain("     2\tbeta");
  });

  it("respects offset and limit and marks truncated", async () => {
    const file = path.join(env.tmpDir, "long.txt");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(file, lines.join("\n"), "utf8");

    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: file, offset: 10, limit: 5 },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("\tline 11");
    expect(result.text).toContain("\tline 15");
    expect(result.text).not.toContain("\tline 10");
    expect(result.text).not.toContain("\tline 16");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.truncated).toBe(true);
  });

  it("records the read in FileStateService", async () => {
    const file = path.join(env.tmpDir, "track.txt");
    await fs.writeFile(file, "hello", "utf8");

    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });
    expect(result.success).toBe(true);

    const data = result.data as Record<string, unknown> | undefined;
    const resolved = String(data?.path);
    const meta = env.fileState.get("test-room", resolved);
    expect(meta).toBeDefined();
    expect(meta?.path).toBe(resolved);
  });

  it("rejects relative paths", async () => {
    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: "relative/path.txt" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("rejects paths outside the configured workspace root", async () => {
    const outside = "/etc/passwd";
    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: outside },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("path_outside_roots");
  });

  it("rejects files larger than CODING_TOOLS_MAX_FILE_SIZE_BYTES", async () => {
    const env2 = await setupEnv("read-big", {
      extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: 32 },
    });
    try {
      const file = path.join(env2.tmpDir, "big.txt");
      await fs.writeFile(file, "x".repeat(64), "utf8");
      const result = await readAction.handler!(env2.runtime, env2.message, undefined, {
        parameters: { file_path: file },
      });
      expect(result.success).toBe(false);
      expect(result.text).toContain("io_error");
      expect(result.text).toContain("offset/limit");
    } finally {
      await env2.cleanup();
    }
  });

  it("rejects binary files containing NUL bytes", async () => {
    const file = path.join(env.tmpDir, "binary.bin");
    await fs.writeFile(file, Buffer.from([0x68, 0x69, 0x00, 0x21]));

    const result = await readAction.handler!(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("binary file");
  });

  it("fails when roomId is missing", async () => {
    const result = await readAction.handler!(
      env.runtime,
      {} as unknown as typeof env.message,
      undefined,
      { parameters: { file_path: path.join(env.tmpDir, "any.txt") } },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("roomId");
  });
});
