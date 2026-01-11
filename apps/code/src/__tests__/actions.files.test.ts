import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { changeDirectoryAction } from "../plugin/actions/change-directory.js";
import { editFileAction } from "../plugin/actions/edit-file.js";
import { listFilesAction } from "../plugin/actions/list-files.js";
import { readFileAction } from "../plugin/actions/read-file.js";
import { searchFilesAction } from "../plugin/actions/search-files.js";
import { writeFileAction } from "../plugin/actions/write-file.js";
import { getCwd, setCwd } from "../plugin/providers/cwd.js";

function createMemory(text: string): Memory {
  return {
    content: { text },
  } as Memory;
}

async function withTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("plugin actions: filesystem + directory", () => {
  const runtime = {} as IAgentRuntime;
  const originalCwd = getCwd();

  let tempDir = "";

  beforeEach(async () => {
    tempDir = await withTempDir("eliza-code-actions-");
    await fs.mkdir(path.join(tempDir, "sub"), { recursive: true });
    await setCwd(tempDir);
  });

  afterEach(async () => {
    try {
      await setCwd(originalCwd);
    } catch {
      // ignore
    }
    try {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  test("WRITE_FILE creates a file when content is provided", async () => {
    const msg = createMemory("create hello.txt\n```txt\nHello world\n```");
    const result = await writeFileAction.handler(runtime, msg);

    expect(result.success).toBe(true);
    expect(result.text).toContain("hello.txt");

    const content = await fs.readFile(path.join(tempDir, "hello.txt"), "utf-8");
    expect(content).toBe("Hello world");
  });

  test("READ_FILE returns file content and fails for directories", async () => {
    await fs.writeFile(path.join(tempDir, "hello.txt"), "Hello", "utf-8");

    const ok = await readFileAction.handler(
      runtime,
      createMemory("read hello.txt"),
    );
    expect(ok.success).toBe(true);
    expect(ok.text).toContain("File: hello.txt");
    expect(ok.text).toContain("Hello");

    const dir = await readFileAction.handler(runtime, createMemory("read sub"));
    expect(dir.success).toBe(false);
    expect(dir.text).toContain("directory");
  });

  test("EDIT_FILE replaces text and reports failures when old text not found", async () => {
    await fs.writeFile(path.join(tempDir, "edit.txt"), "alpha beta", "utf-8");

    const edited = await editFileAction.handler(
      runtime,
      createMemory('edit edit.txt replace "beta" with "gamma"'),
    );
    expect(edited.success).toBe(true);

    const content = await fs.readFile(path.join(tempDir, "edit.txt"), "utf-8");
    expect(content).toBe("alpha gamma");

    const notFound = await editFileAction.handler(
      runtime,
      createMemory('edit edit.txt replace "does-not-exist" with "x"'),
    );
    expect(notFound.success).toBe(false);
    expect(notFound.text).toContain("Could not find");
  });

  test("LIST_FILES lists contents and excludes dotfiles", async () => {
    await fs.writeFile(path.join(tempDir, "a.txt"), "A", "utf-8");
    await fs.writeFile(path.join(tempDir, ".hidden.txt"), "H", "utf-8");
    await fs.mkdir(path.join(tempDir, "dir"), { recursive: true });

    const listed = await listFilesAction.handler(
      runtime,
      createMemory("list files in ."),
    );
    expect(listed.success).toBe(true);
    expect(listed.text).toContain("Directory:");
    expect(listed.text).toContain("a.txt");
    expect(listed.text).toContain("dir/");
    expect(listed.text).not.toContain(".hidden.txt");
  });

  test("SEARCH_FILES finds matches in text files", async () => {
    await fs.writeFile(
      path.join(tempDir, "search.txt"),
      "TODO: fix this\nok\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(tempDir, "other.bin"),
      "\u0000\u0001\u0002",
      "utf-8",
    );

    const searched = await searchFilesAction.handler(
      runtime,
      createMemory('search for "todo" in .'),
    );
    expect(searched.success).toBe(true);
    expect(searched.text).toContain("search.txt");
    expect(searched.text).toContain("TODO: fix this");
  });

  test("CHANGE_DIRECTORY shows current dir when no target is provided and changes dir when target exists", async () => {
    const current = await changeDirectoryAction.handler(
      runtime,
      createMemory("cd"),
    );
    expect(current.success).toBe(true);
    expect(current.text).toContain("CWD:");

    const changed = await changeDirectoryAction.handler(
      runtime,
      createMemory("cd sub"),
    );
    expect(changed.success).toBe(true);
    expect(getCwd()).toBe(path.join(tempDir, "sub"));
  });
});
