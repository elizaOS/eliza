/** Proves file continuations across real process restarts, sandbox revocation, stale content, and locator tampering. */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { readFileHandler } from "./read.js";

let env: TestEnv;
let priorState: string | undefined;
let stateDir: string;
beforeEach(async () => {
  priorState = process.env.ELIZA_STATE_DIR;
  env = await setupEnv("file-reference");
  stateDir = path.join(env.tmpDir, "state");
  process.env.ELIZA_STATE_DIR = stateDir;
});
afterEach(async () => {
  if (priorState === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = priorState;
  await env.cleanup();
});

async function seed() {
  const file = path.join(env.tmpDir, "source.txt");
  await fs.writeFile(file, "first\n猫🙂 unseen second\nlast\n");
  const result = await readFileHandler(env.runtime, env.message, undefined, {
    parameters: { file_path: file, limit: 1 },
  });
  expect(result.success, result.text).toBe(true);
  const { reference } = (
    result.data as {
      readView: { reference: { ref: string; revision: string } };
    }
  ).readView;
  return { file, reference: reference.ref, revision: reference.revision };
}

async function child(input: {
  reference: string;
  revision: string;
  conversationId?: string;
  blockedPath?: string;
}) {
  const script = fileURLToPath(
    new URL("../../scripts/file-reference-read-child.ts", import.meta.url),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      script,
      JSON.stringify({ ...input, workspace: env.tmpDir }),
    ],
    { timeout: 120_000, env: process.env, maxBuffer: 1024 * 1024 },
  );
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("Fresh process returned no file-read result");
  return JSON.parse(line) as {
    success: boolean;
    text: string;
  };
}

it("resumes the exact Unicode range in a fresh process without exposing the native path", async () => {
  const entry = await seed();
  const result = await child(entry);
  expect(result.success, result.text).toBe(true);
  expect(result.text).toBe("猫🙂 unseen second\n");
  expect(JSON.stringify(result)).not.toContain(entry.file);
}, 150_000);

it("rechecks sandbox rules after restart and does not expose the unseen range", async () => {
  const entry = await seed();
  const result = await child({ ...entry, blockedPath: env.tmpDir });
  expect(result.success).toBe(false);
  expect(result.text).not.toContain("unseen second");
  expect(JSON.stringify(result)).not.toContain(entry.file);
}, 150_000);

it("rejects another conversation and a changed file after restart", async () => {
  const entry = await seed();
  const denied = await child({
    ...entry,
    conversationId: "another-conversation",
  });
  expect(denied.success).toBe(false);
  expect(denied.text).not.toContain(entry.file);
  await fs.appendFile(entry.file, "changed\n");
  const stale = await child(entry);
  expect(stale.success).toBe(false);
  expect(stale.text).not.toContain("unseen second");
}, 300_000);

it("rejects modified locator bytes before resolving a path", async () => {
  const entry = await seed();
  await fs.appendFile(
    path.join(
      stateDir,
      "coding-tools",
      "file-reads",
      `${entry.reference.slice(5)}.json`,
    ),
    " ",
  );
  const result = await readFileHandler(env.runtime, env.message, undefined, {
    parameters: {
      reference: entry.reference,
      expectedRevision: entry.revision,
      offset: 1,
      limit: 1,
    },
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain(entry.file);
  expect(JSON.stringify(result)).not.toContain("unseen second");
});

it("rejects a symlinked locator even when the target has valid record bytes", async () => {
  const entry = await seed();
  const locator = path.join(
    stateDir,
    "coding-tools",
    "file-reads",
    `${entry.reference.slice(5)}.json`,
  );
  const replacement = path.join(env.tmpDir, "copied-record.json");
  await fs.rename(locator, replacement);
  await fs.symlink(replacement, locator);
  const result = await readFileHandler(env.runtime, env.message, undefined, {
    parameters: {
      reference: entry.reference,
      expectedRevision: entry.revision,
      offset: 1,
      limit: 1,
    },
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("unseen second");
});

it("fails publication without returning source content when locator storage is invalid", async () => {
  const file = path.join(env.tmpDir, "source.txt");
  await fs.writeFile(file, "unseen source");
  await fs.mkdir(path.join(stateDir, "coding-tools"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "coding-tools", "file-reads"),
    "not a directory",
  );
  const result = await readFileHandler(env.runtime, env.message, undefined, {
    parameters: { file_path: file },
  });
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("unseen source");
});

it("does not disclose the native path when the file disappears before restart", async () => {
  const entry = await seed();
  await fs.unlink(entry.file);
  const result = await child(entry);
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain(entry.file);
  expect(JSON.stringify(result)).not.toContain("unseen second");
}, 150_000);
