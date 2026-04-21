import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(import.meta.dirname, "../src");
const SCHEMA_PATH = path.resolve(SRC_ROOT, "lifeops/schema.ts");

function walkTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const resolved = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      files.push(...walkTsFiles(resolved));
      continue;
    }
    if (entry.isFile() && resolved.endsWith(".ts")) {
      files.push(resolved);
    }
  }
  return files;
}

function referencedLifeTables(files: string[]): Set<string> {
  const tablePattern =
    /\b(?:FROM|INTO|UPDATE|TABLE|JOIN|DELETE FROM)\s+([a-z_][a-z0-9_]*)/gi;
  const names = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = tablePattern.exec(source))) {
      const name = match[1];
      if (name.startsWith("life")) {
        names.add(name);
      }
    }
  }
  names.delete("lifeops");
  return names;
}

function declaredLifeTables(schemaSource: string): Set<string> {
  const tablePattern = /pgTable\s*\(\s*"([a-z_][a-z0-9_]*)"/g;
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(schemaSource))) {
    names.add(match[1]);
  }
  return names;
}

describe("lifeops plugin schema coverage", () => {
  it("declares every lifeops table referenced by non-test source files", () => {
    const files = walkTsFiles(SRC_ROOT);
    const referenced = referencedLifeTables(files);
    const declared = declaredLifeTables(fs.readFileSync(SCHEMA_PATH, "utf8"));
    expect([...referenced].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("does not lazily create lifeops tables in runtime source files", () => {
    const files = walkTsFiles(SRC_ROOT);
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return /CREATE TABLE IF NOT EXISTS\s+life[_a-z0-9]*/i.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
