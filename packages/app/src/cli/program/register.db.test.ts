/**
 * Direct unit coverage for `registerDbCommand`. Drives the real Commander
 * `db reset` action against an isolated `ELIZA_STATE_DIR` and a real
 * filesystem: missing database, `--yes` deletion of a nested tree, default
 * (y/N) confirmation (only trimmed lowercase `"y"` confirms), and
 * cancellation that leaves the directory intact. Stdin is replaced only as
 * the interactive boundary; the module under test is not mocked.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDbCommand } from "./register.db";

const ORIGINAL_STATE_DIR = process.env.ELIZA_STATE_DIR;
const ORIGINAL_STDIN = process.stdin;
const tempDirs: string[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function stateDbDir(stateDir: string): string {
  return path.join(stateDir, "workspace", ".elizadb");
}

function isolateStateDir(): string {
  const stateDir = mkdtempSync(path.join(tmpdir(), "register-db-"));
  tempDirs.push(stateDir);
  process.env.ELIZA_STATE_DIR = stateDir;
  return stateDir;
}

function seedDatabase(stateDir: string, files: Record<string, string>): string {
  const dbDir = stateDbDir(stateDir);
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(dbDir, relative);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return dbDir;
}

function captureConsoleLog(): string[] {
  const logs: string[] = [];
  spies.push(
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    }),
  );
  return logs;
}

function captureStdout(): string[] {
  const chunks: string[] = [];
  spies.push(
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write),
  );
  return chunks;
}

function installStdin(answer: string): PassThrough {
  const stdin = new PassThrough();
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: stdin,
  });
  stdin.write(`${answer}\n`);
  stdin.end();
  return stdin;
}

function restoreStdin(): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: ORIGINAL_STDIN,
  });
}

async function runDbReset(args: string[] = []): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut() {},
    writeErr() {},
  });
  registerDbCommand(program);
  await program.parseAsync(["db", "reset", ...args], { from: "user" });
}

describe("registerDbCommand", () => {
  beforeEach(() => {
    isolateStateDir();
  });

  afterEach(() => {
    restoreStdin();
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers a db group with a reset command and --yes flag", () => {
    const program = new Command();
    registerDbCommand(program);

    const db = program.commands.find((command) => command.name() === "db");
    expect(db).toBeDefined();
    expect(db?.description()).toBe("Database management");
    expect(db?.commands.map((command) => command.name())).toEqual(["reset"]);

    const reset = db?.commands.find((command) => command.name() === "reset");
    expect(reset?.description()).toBe(
      "Delete the local agent database (will be re-created on next start)",
    );
    expect(reset?.options.map((option) => option.long)).toEqual(["--yes"]);
  });

  it("reports nothing to reset when the database directory is missing", async () => {
    const logs = captureConsoleLog();
    const stateDir = process.env.ELIZA_STATE_DIR as string;
    const dbDir = stateDbDir(stateDir);

    expect(existsSync(dbDir)).toBe(false);
    await runDbReset();

    expect(existsSync(dbDir)).toBe(false);
    expect(logs.join("\n")).toContain("Database not found at");
    expect(logs.join("\n")).toContain(dbDir);
    expect(logs.join("\n")).toContain("nothing to reset");
  });

  it("does not hang waiting for a prompt when the database is missing", async () => {
    captureConsoleLog();
    await runDbReset();
  });

  it("skips the missing-directory prompt when --yes is passed", async () => {
    const logs = captureConsoleLog();
    await runDbReset(["--yes"]);
    expect(logs.join("\n")).toContain("nothing to reset");
  });

  it("deletes a nested database tree with --yes and leaves sibling files", async () => {
    const logs = captureConsoleLog();
    const stateDir = process.env.ELIZA_STATE_DIR as string;
    const dbDir = seedDatabase(stateDir, {
      "memories/a.json": '{"id":1}',
      "conversations/thread.txt": "hello",
    });
    const sibling = path.join(stateDir, "workspace", "keep.txt");
    writeFileSync(sibling, "safe");
    const outside = path.join(stateDir, "outside.txt");
    writeFileSync(outside, "untouched");

    expect(existsSync(path.join(dbDir, "memories", "a.json"))).toBe(true);
    await runDbReset(["--yes"]);

    expect(existsSync(dbDir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(readdirSync(path.join(stateDir, "workspace"))).toEqual(["keep.txt"]);
    expect(logs.join("\n")).toContain(`Database deleted: ${dbDir}`);
    expect(logs.join("\n")).toContain("eliza start");
  });

  it("deletes an empty database directory with --yes", async () => {
    const logs = captureConsoleLog();
    const stateDir = process.env.ELIZA_STATE_DIR as string;
    const dbDir = stateDbDir(stateDir);
    mkdirSync(dbDir, { recursive: true });

    await runDbReset(["--yes"]);

    expect(existsSync(dbDir)).toBe(false);
    expect(logs.join("\n")).toContain(`Database deleted: ${dbDir}`);
  });

  it("cancels without deleting when the confirmation is empty (default N)", async () => {
    installStdin("");
    const logs = captureConsoleLog();
    const stdout = captureStdout();
    const stateDir = process.env.ELIZA_STATE_DIR as string;
    const dbDir = seedDatabase(stateDir, { "keep.json": "{}" });

    await runDbReset();

    expect(existsSync(path.join(dbDir, "keep.json"))).toBe(true);
    expect(logs.join("\n")).toContain("Cancelled.");
    expect(logs.join("\n")).not.toContain("Database deleted");
    expect(stdout.join("")).toContain(dbDir);
    expect(stdout.join("")).toContain(
      "All agent memory and conversation history will be lost",
    );
    expect(stdout.join("")).toContain("(y/N)");
  });

  it("cancels when the confirmation is not exactly y after trim and lowercase", async () => {
    for (const answer of ["n", "N", "no", "yes", " yep", "0", "true"]) {
      restoreStdin();
      for (const spy of spies.splice(0)) {
        spy.mockRestore();
      }
      installStdin(answer);
      const logs = captureConsoleLog();
      captureStdout();
      const stateDir = isolateStateDir();
      const dbDir = seedDatabase(stateDir, { "keep.json": answer });

      await runDbReset();

      expect(existsSync(path.join(dbDir, "keep.json")), answer).toBe(true);
      expect(logs.join("\n"), answer).toContain("Cancelled.");
    }
  });

  it("deletes after a confirmed y, including padded and uppercase Y", async () => {
    for (const answer of ["y", "Y", " y", "y ", " Y "]) {
      restoreStdin();
      for (const spy of spies.splice(0)) {
        spy.mockRestore();
      }
      installStdin(answer);
      const logs = captureConsoleLog();
      captureStdout();
      const stateDir = isolateStateDir();
      const dbDir = seedDatabase(stateDir, { "gone.json": "x" });

      await runDbReset();

      expect(existsSync(dbDir), answer).toBe(false);
      expect(logs.join("\n"), answer).toContain(`Database deleted: ${dbDir}`);
      expect(logs.join("\n"), answer).toContain("eliza start");
    }
  });

  it("does not prompt when --yes deletes an existing database", async () => {
    const logs = captureConsoleLog();
    const stateDir = process.env.ELIZA_STATE_DIR as string;
    seedDatabase(stateDir, { "gone.json": "x" });

    await runDbReset(["--yes"]);

    expect(existsSync(stateDbDir(stateDir))).toBe(false);
    expect(logs.join("\n")).toContain("Database deleted:");
  });
});
