/**
 * Exercises appendJsonlRecord and appendJsonlRecordAsync against real
 * temporary files: a torn tail is isolated on its own line, a new or empty
 * file gets no leading blank line, and an ordinary append is byte-identical
 * to the plain form.
 */

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJsonlRecord, appendJsonlRecordAsync } from "./jsonl-append";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "jsonl-append-"));
});

afterEach(async () => {
  await Promise.resolve();
  rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n");
}

for (const variant of [
  { name: "appendJsonlRecord", append: appendJsonlRecord },
  { name: "appendJsonlRecordAsync", append: appendJsonlRecordAsync },
] as const) {
  describe(variant.name, () => {
    it("creates the file and writes exactly one line", async () => {
      const file = path.join(dir, "new.jsonl");
      await variant.append(file, { n: 1 }, { mode: 0o600 });
      expect(readFileSync(file, "utf8")).toBe('{"n":1}\n');
      if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });

    it("appends to a well-formed file byte for byte like a plain append", async () => {
      const file = path.join(dir, "plain.jsonl");
      writeFileSync(file, '{"n":1}\n');
      await variant.append(file, { n: 2 });
      expect(readFileSync(file, "utf8")).toBe('{"n":1}\n{"n":2}\n');
    });

    it("does not add a blank line to an empty file", async () => {
      const file = path.join(dir, "empty.jsonl");
      writeFileSync(file, "");
      await variant.append(file, { n: 1 });
      expect(readFileSync(file, "utf8")).toBe('{"n":1}\n');
    });

    it("isolates a crash-torn tail so the next record is intact", async () => {
      const file = path.join(dir, "torn.jsonl");
      writeFileSync(file, '{"n":1}\n');
      // An append interrupted before its trailing newline.
      appendFileSync(file, '{"n":2,"tokens":');
      await variant.append(file, { n: 3 });
      expect(lines(file)).toEqual([
        '{"n":1}',
        '{"n":2,"tokens":',
        '{"n":3}',
        "",
      ]);
      expect(JSON.parse(lines(file)[2])).toEqual({ n: 3 });
    });

    it("recovers a complete record that only lost its newline", async () => {
      const file = path.join(dir, "no-newline.jsonl");
      writeFileSync(file, '{"n":1}');
      await variant.append(file, { n: 2 });
      expect(
        lines(file)
          .slice(0, 2)
          .map((line) => JSON.parse(line)),
      ).toEqual([{ n: 1 }, { n: 2 }]);
    });
  });
}
