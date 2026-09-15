/**
 * Exercises appendJsonlRecord against real temporary files: a torn tail is
 * isolated on its own line, a new or empty file gets no leading blank line,
 * and an ordinary append is byte-identical to the plain form.
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
import { appendJsonlRecord } from "./jsonl-append";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "jsonl-append-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n");
}

describe("appendJsonlRecord", () => {
  it("creates the file and writes exactly one line", () => {
    const file = path.join(dir, "new.jsonl");
    appendJsonlRecord(file, { n: 1 }, { mode: 0o600 });
    expect(readFileSync(file, "utf8")).toBe('{"n":1}\n');
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("appends to a well-formed file byte for byte like a plain append", () => {
    const file = path.join(dir, "plain.jsonl");
    writeFileSync(file, '{"n":1}\n');
    appendJsonlRecord(file, { n: 2 });
    expect(readFileSync(file, "utf8")).toBe('{"n":1}\n{"n":2}\n');
  });

  it("does not add a blank line to an empty file", () => {
    const file = path.join(dir, "empty.jsonl");
    writeFileSync(file, "");
    appendJsonlRecord(file, { n: 1 });
    expect(readFileSync(file, "utf8")).toBe('{"n":1}\n');
  });

  it("isolates a crash-torn tail so the next record is intact", () => {
    const file = path.join(dir, "torn.jsonl");
    writeFileSync(file, '{"n":1}\n');
    // An append interrupted before its trailing newline.
    appendFileSync(file, '{"n":2,"tokens":');
    appendJsonlRecord(file, { n: 3 });
    expect(lines(file)).toEqual(['{"n":1}', '{"n":2,"tokens":', '{"n":3}', ""]);
    expect(JSON.parse(lines(file)[2])).toEqual({ n: 3 });
  });

  it("recovers a complete record that only lost its newline", () => {
    const file = path.join(dir, "no-newline.jsonl");
    writeFileSync(file, '{"n":1}');
    appendJsonlRecord(file, { n: 2 });
    expect(
      lines(file)
        .slice(0, 2)
        .map((line) => JSON.parse(line)),
    ).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
