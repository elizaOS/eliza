import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTools, parseToolCalls } from "../lib/sub-agents/tools.js";

type Tool = ReturnType<typeof createTools>[number];

function getTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool "${name}" not found`);
  }
  return tool;
}

describe("createTools", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-code-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should create all expected tools", () => {
    const tools = createTools(testDir);
    const names = tools.map((t) => t.name);

    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("list_files");
    expect(names).toContain("search_files");
    expect(names).toContain("shell");
  });

  describe("read_file", () => {
    it("should read file contents", async () => {
      const tools = createTools(testDir);
      const readFile = getTool(tools, "read_file");

      await fs.writeFile(path.join(testDir, "test.txt"), "Hello World");
      const result = await readFile.execute({ filepath: "test.txt" });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Hello World");
    });

    it("should return error for missing file", async () => {
      const tools = createTools(testDir);
      const readFile = getTool(tools, "read_file");

      const result = await readFile.execute({ filepath: "missing.txt" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("File not found");
    });
  });

  describe("write_file", () => {
    it("should create new file", async () => {
      const tools = createTools(testDir);
      const writeFile = getTool(tools, "write_file");

      const result = await writeFile.execute({
        filepath: "new.txt",
        content: "New content",
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(path.join(testDir, "new.txt"), "utf-8");
      expect(content).toBe("New content");
    });

    it("should create directories if needed", async () => {
      const tools = createTools(testDir);
      const writeFile = getTool(tools, "write_file");

      const result = await writeFile.execute({
        filepath: "nested/dir/file.txt",
        content: "Nested content",
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(
        path.join(testDir, "nested/dir/file.txt"),
        "utf-8",
      );
      expect(content).toBe("Nested content");
    });
  });

  describe("edit_file", () => {
    it("should replace text in file", async () => {
      const tools = createTools(testDir);
      const editFile = getTool(tools, "edit_file");

      await fs.writeFile(path.join(testDir, "edit.txt"), "Hello World");
      const result = await editFile.execute({
        filepath: "edit.txt",
        old_str: "World",
        new_str: "Universe",
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(
        path.join(testDir, "edit.txt"),
        "utf-8",
      );
      expect(content).toBe("Hello Universe");
    });

    it("should fail if text not found", async () => {
      const tools = createTools(testDir);
      const editFile = getTool(tools, "edit_file");

      await fs.writeFile(path.join(testDir, "edit.txt"), "Hello World");
      const result = await editFile.execute({
        filepath: "edit.txt",
        old_str: "NotFound",
        new_str: "Replace",
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Could not find");
    });
  });

  describe("list_files", () => {
    it("should list directory contents", async () => {
      const tools = createTools(testDir);
      const listFiles = getTool(tools, "list_files");

      await fs.writeFile(path.join(testDir, "file1.txt"), "");
      await fs.writeFile(path.join(testDir, "file2.txt"), "");
      await fs.mkdir(path.join(testDir, "subdir"));

      const result = await listFiles.execute({ path: "." });

      expect(result.success).toBe(true);
      expect(result.output).toContain("file1.txt");
      expect(result.output).toContain("file2.txt");
      expect(result.output).toContain("subdir");
    });
  });

  describe("search_files", () => {
    it("should search text across files", async () => {
      const tools = createTools(testDir);
      const searchFiles = getTool(tools, "search_files");

      await fs.writeFile(
        path.join(testDir, "a.txt"),
        "hello world\nsecond\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(testDir, "b.ts"),
        "const x = 'world';\n",
        "utf-8",
      );

      const result = await searchFiles.execute({ pattern: "world", path: "." });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Search "world"');
      expect(result.output).toContain("a.txt");
      expect(result.output).toContain("b.ts");
    });
  });

  describe("shell", () => {
    it("should execute shell command", async () => {
      const tools = createTools(testDir);
      const shell = getTool(tools, "shell");

      const result = await shell.execute({ command: "echo 'test'" });

      expect(result.success).toBe(true);
      expect(result.output).toContain("test");
    });

    it("should block dangerous commands", async () => {
      const tools = createTools(testDir);
      const shell = getTool(tools, "shell");

      const result = await shell.execute({ command: "rm -rf /" });

      expect(result.success).toBe(false);
      expect(result.output).toContain("Blocked");
    });
  });
});

describe("parseToolCalls", () => {
  it("should parse simple tool call", () => {
    const text = 'I will read the file. TOOL: read_file(filepath="test.txt")';
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].args.filepath).toBe("test.txt");
  });

  it("should parse multiple tool calls", () => {
    const text = `
      First, TOOL: list_files(path="src")
      Then, TOOL: read_file(filepath="main.ts")
    `;
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("list_files");
    expect(calls[1].name).toBe("read_file");
  });

  it("should parse tool call with multiple args", () => {
    const text =
      'TOOL: edit_file(filepath="test.ts", old_str="old", new_str="new")';
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0].args.filepath).toBe("test.ts");
    expect(calls[0].args.old_str).toBe("old");
    expect(calls[0].args.new_str).toBe("new");
  });

  it("should extract content from CONTENT_START/CONTENT_END", () => {
    const text = `
      TOOL: write_file(filepath="test.ts")
      CONTENT_START
      const x = 1;
      const y = 2;
      CONTENT_END
    `;
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("write_file");
    expect(calls[0].args.content).toContain("const x = 1");
    expect(calls[0].args.content).toContain("const y = 2");
  });

  it("should extract content from code blocks", () => {
    const text = `
      TOOL: write_file(filepath="test.ts")
      \`\`\`typescript
      function hello() {
        return "world";
      }
      \`\`\`
    `;
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(1);
    expect(calls[0].args.content).toContain("function hello()");
  });

  it("should return empty array for no tool calls", () => {
    const text = "Just some regular text without any tool calls.";
    const calls = parseToolCalls(text);

    expect(calls).toHaveLength(0);
  });
});
