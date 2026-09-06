/** Exercises migration source failures with real files and a CLI subprocess, preserving absent-file compatibility. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { buildMigrationPlan } from "./index.js";
import {
  MigrationSourceReadError,
  readOcAgentHome,
} from "./openclaw-reader.js";

const roots: string[] = [];
function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-read-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "MEMORY.md"),
    "Available long-term memory must not conceal missing source data.",
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

it("rejects a wrong-type persona before CLI output is written", () => {
  const root = home();
  fs.mkdirSync(path.join(root, "SOUL.md"));
  expect(() => buildMigrationPlan({ from: root, agentId: "demo" })).toThrow(
    MigrationSourceReadError,
  );
  const character = path.join(root, "character.json");
  const archive = path.join(root, "export.eliza-agent");
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const result = spawnSync(
    "bun",
    [
      cli,
      "migrate-agent",
      "--from",
      root,
      "--agent-id",
      "demo",
      "--emit-character",
      character,
      "--out",
      archive,
      "--password",
      "synthetic-test-password",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("MIGRATION_SOURCE_READ_FAILED");
  expect(result.stderr).toContain(path.join(root, "SOUL.md"));
  expect(fs.existsSync(character)).toBe(false);
  expect(fs.existsSync(archive)).toBe(false);
});

it("rejects a non-directory memory root instead of treating it as empty", () => {
  const root = home();
  fs.writeFileSync(path.join(root, "memory"), "not a directory");
  expect(() => readOcAgentHome(root, "demo")).toThrow(MigrationSourceReadError);
});

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["SOUL.md", "memory/2026-09-06.md", "memory"])(
  "preserves the actual filesystem failure for unreadable %s",
  (relative) => {
    const root = home();
    const target = path.join(root, relative);
    fs.mkdirSync(path.join(root, "memory"));
    if (relative !== "memory")
      fs.writeFileSync(target, "Source must not disappear.");
    fs.chmodSync(target, 0);
    try {
      let caught: unknown;
      try {
        buildMigrationPlan({ from: root, agentId: "demo" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationSourceReadError);
      const error = caught as MigrationSourceReadError;
      expect(error.context.path).toBe(target);
      expect(error.cause).toMatchObject({ code: "EACCES" });
    } finally {
      fs.chmodSync(target, relative === "memory" ? 0o700 : 0o600);
    }
  },
);

it("still builds a partial home when optional files are absent", () => {
  const root = home();
  const plan = buildMigrationPlan({ from: root, agentId: "demo" });
  expect(plan.summary.warnings).toEqual([]);
  expect(
    readOcAgentHome(path.join(root, "absent"), "demo").soul,
  ).toBeUndefined();
});
