/** Exercises argument, output, and early-exit CLI behavior without starting an agent runtime. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatOutput, getMessage, main, parseArgs, runCLI } from "./cli.js";

const originalProvider = process.env.ELIZA_CODE_PROVIDER;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalProvider === undefined) delete process.env.ELIZA_CODE_PROVIDER;
  else process.env.ELIZA_CODE_PROVIDER = originalProvider;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("CLI boundaries", () => {
  it("parses flags, paths, and a multi-word message", () => {
    expect(
      parseArgs(["--json", "--stream", "--cwd", "/tmp", "review", "this"]),
    ).toMatchObject({
      json: true,
      stream: true,
      cwd: "/tmp",
      message: "review this",
    });
    expect(() => parseArgs(["--file"])).toThrow(
      "--file requires a path argument",
    );
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option");
  });

  it("reads direct and file-backed messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-code-cli-"));
    const file = join(directory, "prompt.txt");
    await writeFile(file, "  from disk  \n");
    try {
      expect(await getMessage(parseArgs(["direct message"]))).toBe(
        "direct message",
      );
      expect(await getMessage(parseArgs(["--file", file]))).toBe("from disk");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("formats plain and JSON results", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value?: unknown) => logs.push(String(value));
    console.error = (value?: unknown) => errors.push(String(value));
    try {
      formatOutput({ success: true, response: "done" }, parseArgs([]));
      formatOutput({ success: false, error: "broken" }, parseArgs([]));
      formatOutput({ success: true, response: "json" }, parseArgs(["--json"]));
      expect(logs[0]).toBe("done");
      expect(logs[1]).toContain('"response": "json"');
      expect(errors).toEqual(["Error: broken"]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it("handles help, interactive mode, and missing provider credentials", async () => {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      expect(await main(["--help"])).toBe(0);
      expect(await main(["--interactive"])).toBe(-1);
      process.env.ELIZA_CODE_PROVIDER = "openai";
      delete process.env.OPENAI_API_KEY;
      expect(await main(["hello"])).toBe(1);
      process.env.ELIZA_CODE_PROVIDER = "invalid";
      expect(await main(["hello"])).toBe(1);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it("rejects an invalid working directory before runtime initialization", async () => {
    const result = await runCLI(
      parseArgs(["--cwd", "/definitely/missing/eliza-code", "hello"]),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to set working directory");
  });
});
