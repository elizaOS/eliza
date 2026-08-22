/** Tests bounded FILE reads, resumable metadata, and read recording over the real filesystem. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  CapabilityError,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  UnavailableCapabilityRouter,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { readFileHandler } from "./read.js";

describe("READ", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("read-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("reads a small file as an exact page with a complete ReadView", async () => {
    const file = path.join(env.tmpDir, "hello.txt");
    await fs.writeFile(file, "line one\nline two\nline three", "utf8");

    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("line one\nline two\nline three");
    const data = result.data as Record<string, unknown> | undefined;
    const readView = data?.readView as {
      slice: { completeness: string; range: { start: number; end: number } };
    };
    expect(readView.slice.completeness).toBe("complete");
    expect(readView.slice.range).toMatchObject({ start: 0, end: 3 });
    expect(result.promptData).toEqual({ readView: data?.readView });
  });

  it("fences the user-facing callback while the planner-facing text stays raw (#16563)", async () => {
    const file = path.join(env.tmpDir, "markdown.md");
    await fs.writeFile(file, "**bold** and `code` and *.md globs", "utf8");
    const posts: Array<{ text: string; source?: string }> = [];

    const result = await readFileHandler(
      env.runtime,
      env.message,
      undefined,
      { parameters: { file_path: file } },
      async (content) => {
        posts.push(content as { text: string; source?: string });
        return [];
      },
    );

    expect(result.success).toBe(true);
    // Planner-facing ActionResult text stays raw.
    expect(result.text?.startsWith("```")).toBe(false);
    // The user-facing relay is fenced and source-tagged so chat connectors
    // render the file content verbatim instead of eating `*`/`_` pairs.
    expect(posts).toHaveLength(1);
    expect(posts[0].source).toBe("coding-tools");
    expect(posts[0].text.startsWith("```")).toBe(true);
    expect(posts[0].text.trimEnd().endsWith("```")).toBe(true);
    expect(posts[0].text).toContain("**bold**");
  });

  it("caps only the visible callback for long reads", async () => {
    const file = path.join(env.tmpDir, "long-visible-read.txt");
    const lines = Array.from(
      { length: 300 },
      (_, index) =>
        `line-${index.toString().padStart(3, "0")}-xxxxxxxxxxxxxxxxxxxx`,
    );
    await fs.writeFile(file, lines.join("\n"), "utf8");
    const posts: Array<{ text: string; source?: string }> = [];

    const result = await readFileHandler(
      env.runtime,
      env.message,
      undefined,
      { parameters: { file_path: file } },
      async (content) => {
        posts.push(content as { text: string; source?: string });
        return [];
      },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain(lines[0]);
    expect(result.text).toContain(lines[150]);
    expect(result.text).toContain(lines[299]);
    expect(result.text).not.toContain("lines omitted — ask to see more");

    expect(posts).toHaveLength(1);
    expect(posts[0].source).toBe("coding-tools");
    expect(posts[0].text.startsWith("```")).toBe(true);
    expect(posts[0].text.trimEnd().endsWith("```")).toBe(true);
    expect(posts[0].text).toContain(lines[0]);
    expect(posts[0].text).not.toContain(lines[150]);
    expect(posts[0].text).toContain(lines[299]);
    expect(posts[0].text).toMatch(/\[\d+ lines omitted — ask to see more\]/);
    expect(posts[0].text.length).toBeLessThan(1700);
  });

  it("does not decorate exact page text with line numbers", async () => {
    const file = path.join(env.tmpDir, "lines.txt");
    await fs.writeFile(file, "alpha\nbeta", "utf8");

    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("alpha\nbeta");
  });

  it("retains line terminators so sequential line pages reassemble exactly", async () => {
    const file = path.join(env.tmpDir, "terminators.txt");
    await fs.writeFile(file, "alpha\r\nbeta\ngamma\r\n", "utf8");
    const first = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, limit: 1 },
    });
    const firstView = (first.data as Record<string, unknown>).readView as {
      reference: { revision: string };
      slice: { nextOffset: number };
    };
    const second = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        offset: firstView.slice.nextOffset,
        limit: 2,
      },
    });
    expect(`${first.text}${second.text}`).toBe("alpha\r\nbeta\ngamma\r\n");
  });

  it("accepts an exact EOF line offset after caching the EOF checkpoint", async () => {
    const file = path.join(env.tmpDir, "cached-eof.txt");
    await fs.writeFile(file, "alpha\nbeta\n", "utf8");
    const first = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, limit: 10 },
    });
    const firstView = (first.data as Record<string, unknown>).readView as {
      reference: { revision: string };
      slice: { range: { total: number } };
    };

    const eof = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        offset: firstView.slice.range.total,
        limit: 1,
        expectedRevision: firstView.reference.revision,
      },
    });

    expect(eof.success).toBe(true);
    expect(eof.text).toBe("");
    expect(
      (
        (eof.data as Record<string, unknown>).readView as {
          slice: { range: { start: number; end: number; total: number } };
        }
      ).slice.range,
    ).toEqual({ unit: "line", start: 2, end: 2, total: 2 });
  });

  it("accepts exact EOF from a cold line checkpoint after a byte-mode revision read", async () => {
    const file = path.join(env.tmpDir, "cold-eof.txt");
    await fs.writeFile(file, "alpha\nbeta\n", "utf8");
    const byteRead = await readFileHandler(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: { file_path: file, unit: "byte", limit: 1 },
      },
    );
    const revision = (
      (byteRead.data as Record<string, unknown>).readView as {
        reference: { revision: string };
      }
    ).reference.revision;

    const eof = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "line",
        offset: 2,
        limit: 1,
        expectedRevision: revision,
      },
    });

    expect(eof.success).toBe(true);
    expect(eof.text).toBe("");
    expect(
      (
        (eof.data as Record<string, unknown>).readView as {
          slice: { range: { start: number; end: number; total: number } };
        }
      ).slice.range,
    ).toEqual({ unit: "line", start: 2, end: 2, total: 2 });
  });

  it("respects offset and limit and marks truncated", async () => {
    const file = path.join(env.tmpDir, "long.txt");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(file, lines.join("\n"), "utf8");

    const initial = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, offset: 0, limit: 10 },
    });
    const initialView = (initial.data as Record<string, unknown>).readView as {
      reference: { revision: string };
    };
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        offset: 10,
        limit: 5,
        expectedRevision: initialView.reference.revision,
      },
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("line 11");
    expect(result.text).toContain("line 15");
    expect(result.text).not.toContain("line 10");
    expect(result.text).not.toContain("line 16");
    const data = result.data as Record<string, unknown> | undefined;
    const readView = data?.readView as {
      slice: { completeness: string; nextOffset: number };
    };
    expect(readView.slice.completeness).toBe("partial-recoverable");
    expect(readView.slice.nextOffset).toBe(15);
  });

  it("records the read in FileStateService", async () => {
    const file = path.join(env.tmpDir, "track.txt");
    await fs.writeFile(file, "hello", "utf8");

    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });
    expect(result.success).toBe(true);

    const meta = env.fileState.get("test-room", file);
    expect(meta).toBeDefined();
    expect(meta?.path).toBe(file);
  });

  it("uses bounded native I/O instead of the whole-file capability", async () => {
    const file = path.join(env.tmpDir, "routed.txt");
    await fs.writeFile(file, "local file content", "utf8");
    const calls: string[] = [];
    const router: ElizaCapabilityRouter = {
      environment: "desktop",
      availability: async () => ({
        environment: "desktop",
        available: true,
        capabilities: {
          fs: true,
          pty: false,
          git: false,
          model: false,
          plugin: false,
        },
      }),
      fs: {
        list: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "fs unavailable",
            capability: "fs",
            method: "fs.list",
          });
        },
        readText: async (params) => {
          calls.push(params.path);
          return {
            path: params.path,
            text: "routed line one\nrouted line two",
            size: 29,
            truncated: false,
          };
        },
        writeText: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "fs unavailable",
            capability: "fs",
            method: "fs.writeText",
          });
        },
      },
      pty: {
        runCommand: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "terminal unavailable",
            capability: "pty",
            method: "pty.command.run",
          });
        },
      },
      git: {
        status: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "git unavailable",
            capability: "git",
            method: "git.status",
          });
        },
        diff: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "git unavailable",
            capability: "git",
            method: "git.diff",
          });
        },
        commandRun: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "git unavailable",
            capability: "git",
            method: "git.command.run",
          });
        },
      },
      model: {
        status: async () => {
          throw new CapabilityError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "model unavailable",
            capability: "model",
            method: "model.status",
          });
        },
      },
      plugin: new UnavailableCapabilityRouter("desktop").plugin,
    };
    const runtime = {
      ...env.runtime,
      getService: <T>(serviceType: string): T | null =>
        serviceType === CAPABILITY_ROUTER_SERVICE_TYPE
          ? (router as T)
          : env.runtime.getService<T>(serviceType),
    } as IAgentRuntime;

    const result = await readFileHandler(runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe("local file content");
    expect(calls).toEqual([]);
    const meta = env.fileState.get("test-room", file);
    expect(meta).toBeDefined();
  });

  it("resolves relative paths against the session cwd", async () => {
    env.sessionCwd.setCwd("test-room", env.tmpDir);
    await fs.writeFile(path.join(env.tmpDir, "rel-note.md"), "hello cwd");
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "rel-note.md" },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("hello cwd");
  });

  it("reports a missing session cwd service for relative paths", async () => {
    const getService = vi
      .spyOn(env.runtime, "getService")
      .mockReturnValueOnce(null);
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "rel-note.md" },
    });
    getService.mockRestore();

    expect(result.success).toBe(false);
    expect(result.text).toContain("SessionCwdService unavailable");
  });

  it("rejects UNC input before resolving a relative path", async () => {
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "//server/share/file.txt" },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("UNC paths are not supported");
  });

  it("reports a non-absolute cwd returned by the session service", async () => {
    const getCwd = vi
      .spyOn(env.sessionCwd, "getCwd")
      .mockReturnValueOnce("relative-cwd");
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: "note.md" },
    });
    getCwd.mockRestore();

    expect(result.success).toBe(false);
    expect(result.text).toContain("non-absolute working directory");
  });

  it("rejects paths under the blocklist", async () => {
    const file = path.join(env.blockedPath, "secret.txt");
    await fs.writeFile(file, "data");
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("reads files larger than the page budget with bounded byte pagination", async () => {
    const env2 = await setupEnv("read-big", {
      extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: 32 },
    });
    try {
      const file = path.join(env2.tmpDir, "big.txt");
      await fs.writeFile(file, "x".repeat(64), "utf8");
      const result = await readFileHandler(
        env2.runtime,
        env2.message,
        undefined,
        {
          parameters: { file_path: file, unit: "byte", limit: 16 },
        },
      );
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const readView = data.readView as {
        slice: { hasMore: boolean; nextOffset: number };
      };
      const diagnostics = data.diagnostics as Record<string, number>;
      expect(readView.slice.hasMore).toBe(true);
      expect(readView.slice.nextOffset).toBe(16);
      expect(diagnostics.bytesReturned).toBe(16);
      expect(diagnostics.sourceBytesRead).toBeLessThanOrEqual(19);
    } finally {
      await env2.cleanup();
    }
  });

  it("streams a bounded line page from a file larger than the page budget", async () => {
    const env2 = await setupEnv("read-big-line-window", {
      extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: 64 },
    });
    try {
      const file = path.join(env2.tmpDir, "big-lines.txt");
      const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`);
      await fs.writeFile(file, lines.join("\n"), "utf8");
      const first = await readFileHandler(
        env2.runtime,
        env2.message,
        undefined,
        { parameters: { file_path: file, unit: "line", limit: 1 } },
      );
      const revision = (
        (first.data as Record<string, unknown>).readView as {
          reference: { revision: string };
        }
      ).reference.revision;

      const result = await readFileHandler(
        env2.runtime,
        env2.message,
        undefined,
        {
          parameters: {
            file_path: file,
            unit: "line",
            offset: 40,
            limit: 3,
            expectedRevision: revision,
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.text).toBe("line-40\nline-41\nline-42\n");
      const data = result.data as Record<string, unknown>;
      expect(
        (data.readView as { slice: { range: unknown } }).slice.range,
      ).toMatchObject({ unit: "line", start: 40, end: 43 });
      expect(
        (data.diagnostics as { bytesReturned: number }).bytesReturned,
      ).toBe(Buffer.byteLength(result.text ?? ""));
      expect(env2.fileState.get("test-room", file)).toBeDefined();
    } finally {
      await env2.cleanup();
    }
  });

  it("rejects a requested line page whose selected content exceeds the byte cap", async () => {
    const env2 = await setupEnv("read-big-line-window-cap", {
      extraSettings: { CODING_TOOLS_MAX_FILE_SIZE_BYTES: 32 },
    });
    try {
      const file = path.join(env2.tmpDir, "huge-line-page.txt");
      await fs.writeFile(file, `${"x".repeat(128)}\ntail`, "utf8");
      const result = await readFileHandler(
        env2.runtime,
        env2.message,
        undefined,
        { parameters: { file_path: file, unit: "line", limit: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.text).toContain("line window exceeds 32 bytes");
      expect(result.text).toContain("retry with unit=byte");
    } finally {
      await env2.cleanup();
    }
  });

  it("round-trips Unicode byte pages and rejects stale continuations", async () => {
    const file = path.join(env.tmpDir, "unicode.txt");
    await fs.writeFile(file, "ab😀cdéfg", "utf8");
    const first = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, unit: "byte", offset: 0, limit: 6 },
    });
    expect(first.success).toBe(true);
    const firstData = first.data as Record<string, unknown>;
    expect(first.text).toBe("ab😀");
    const firstView = firstData.readView as {
      reference: { revision: string };
      slice: { nextOffset: number };
    };
    expect(firstView.slice.nextOffset).toBe(6);
    const second = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "byte",
        offset: 6,
        limit: 32,
        expectedRevision: firstView.reference.revision,
      },
    });
    expect(second.success).toBe(true);
    expect(second.text).toBe("cdéfg");
    await fs.writeFile(file, "changed", "utf8");
    const stale = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "byte",
        offset: 6,
        limit: 32,
        expectedRevision: firstView.reference.revision,
      },
    });
    expect(stale.success).toBe(false);
    expect(stale.text).toContain("stale_read");
  });

  it("handles a huge single line without whole-file I/O", async () => {
    const file = path.join(env.tmpDir, "huge-line.txt");
    await fs.writeFile(file, "x".repeat(2 * 1024 * 1024), "utf8");
    const initial = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, unit: "byte", limit: 1 },
    });
    const revision = (
      (initial.data as Record<string, unknown>).readView as {
        reference: { revision: string };
      }
    ).reference.revision;
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "byte",
        offset: 1024 * 1024,
        limit: 4096,
        expectedRevision: revision,
      },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const diagnostics = data.diagnostics as Record<string, number>;
    expect(diagnostics.bytesReturned).toBe(4096);
    expect(diagnostics.sourceBytesRead).toBeLessThanOrEqual(4099);
  });

  it("keeps sequential byte pagination linear in source bytes read", async () => {
    const file = path.join(env.tmpDir, "linear.txt");
    const body = "0123456789abcdef".repeat(64 * 1024);
    await fs.writeFile(file, body, "utf8");
    let offset = 0;
    let sourceBytesRead = 0;
    let revision: string | undefined;
    let reassembled = "";
    while (offset < Buffer.byteLength(body)) {
      const result = await readFileHandler(
        env.runtime,
        env.message,
        undefined,
        {
          parameters: {
            file_path: file,
            unit: "byte",
            offset,
            limit: 64 * 1024,
            ...(revision ? { expectedRevision: revision } : {}),
          },
        },
      );
      expect(result.success).toBe(true);
      reassembled += result.text;
      const data = result.data as Record<string, unknown>;
      const view = data.readView as {
        reference: { revision: string };
        slice: { nextOffset?: number };
      };
      const diagnostics = data.diagnostics as Record<string, number>;
      sourceBytesRead += diagnostics.sourceBytesRead;
      revision = view.reference.revision;
      offset = view.slice.nextOffset ?? Buffer.byteLength(body);
    }
    expect(reassembled).toBe(body);
    expect(sourceBytesRead).toBeLessThanOrEqual(
      Buffer.byteLength(body) + 3 * 16,
    );
  });

  it("keeps sequential line pagination within two read buffers of source size", async () => {
    const file = path.join(env.tmpDir, "linear-lines.txt");
    const body = Array.from(
      { length: 2_000 },
      (_, index) => `line-${index}`,
    ).join("\n");
    await fs.writeFile(file, body, "utf8");
    let offset = 0;
    let sourceBytesRead = 0;
    let revision: string | undefined;
    let pages = 0;
    while (true) {
      const result = await readFileHandler(
        env.runtime,
        env.message,
        undefined,
        {
          parameters: {
            file_path: file,
            unit: "line",
            offset,
            limit: 100,
            ...(revision ? { expectedRevision: revision } : {}),
          },
        },
      );
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const view = data.readView as {
        reference: { revision: string };
        slice: { hasMore: boolean; nextOffset?: number };
      };
      sourceBytesRead += (data.diagnostics as Record<string, number>)
        .sourceBytesRead;
      revision = view.reference.revision;
      pages += 1;
      if (!view.slice.hasMore) break;
      offset = view.slice.nextOffset as number;
    }
    expect(pages).toBe(20);
    expect(sourceBytesRead).toBeLessThanOrEqual(
      Buffer.byteLength(body) + 2 * 64 * 1024,
    );
  });

  it("refuses a byte offset inside a UTF-8 code point", async () => {
    const file = path.join(env.tmpDir, "boundary.txt");
    await fs.writeFile(file, "😀tail", "utf8");
    const initial = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, unit: "byte", limit: 4 },
    });
    const revision = (
      (initial.data as Record<string, unknown>).readView as {
        reference: { revision: string };
      }
    ).reference.revision;
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: {
        file_path: file,
        unit: "byte",
        offset: 1,
        limit: 4,
        expectedRevision: revision,
      },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("UTF-8 character boundary");
  });

  it("requires an initial read before a nonzero continuation", async () => {
    const file = path.join(env.tmpDir, "revision-required.txt");
    await fs.writeFile(file, "alpha\nbeta\n", "utf8");
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, offset: 1, limit: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("read from offset 0");
  });

  it("rejects an automatic continuation when the file changed after the initial read", async () => {
    const file = path.join(env.tmpDir, "automatic-revision-stale.txt");
    await fs.writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const first = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, limit: 1 },
    });
    expect(first.success).toBe(true);

    await fs.appendFile(file, "delta\n", "utf8");
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, offset: 1, limit: 1 },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("expected revision");

    const refreshed = await readFileHandler(
      env.runtime,
      env.message,
      undefined,
      { parameters: { file_path: file, offset: 0, limit: 1 } },
    );
    expect(refreshed.success).toBe(true);
    expect(refreshed.text).toBe("alpha\n");

    const resumed = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, offset: 1, limit: 1 },
    });
    expect(resumed.success).toBe(true);
    expect(resumed.text).toBe("beta\n");
  });

  it("rejects binary files containing NUL bytes", async () => {
    const file = path.join(env.tmpDir, "binary.bin");
    await fs.writeFile(file, Buffer.from([0x68, 0x69, 0x00, 0x21]));

    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file },
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("binary file");
  });

  it("rejects malformed UTF-8 instead of returning an empty successful page", async () => {
    const file = path.join(env.tmpDir, "invalid-utf8.txt");
    await fs.writeFile(file, Buffer.from([0x61, 0xff, 0x62, 0x63]));
    const result = await readFileHandler(env.runtime, env.message, undefined, {
      parameters: { file_path: file, unit: "byte", limit: 4 },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("valid UTF-8 page");
  });

  it("fails when roomId is missing", async () => {
    const result = await readFileHandler(
      env.runtime,
      {} as typeof env.message,
      undefined,
      { parameters: { file_path: path.join(env.tmpDir, "any.txt") } },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("roomId");
  });
});
