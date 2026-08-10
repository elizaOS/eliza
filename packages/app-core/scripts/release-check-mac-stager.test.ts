/**
 * Mutation tests for the macOS artifact-stager gate (#17680).
 *
 * These run against the REAL stager script, not a fixture: the gate's whole job
 * is to notice edits to that file, so a fixture would test the fixture. Each
 * case mutates a copy of the real script and asserts the gate's own predicate
 * changes verdict. A test that only checks the unmodified script passes is the
 * failure mode that let this regression exist.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  containsContiguousBlock,
  requiredMacStaplerFailureBlock,
} from "./lib/mac-stager-contract";

const here = path.dirname(fileURLToPath(import.meta.url));
const stagerPath = path.join(
  here,
  "../platforms/electrobun/scripts/stage-macos-release-artifacts.sh",
);
const stager = readFileSync(stagerPath, "utf8");

/**
 * Index of `trimmed` INSIDE the guarded block, not merely the first in the file.
 *
 * `exit 1` occurs nine times in this script and `fi` fifty-eight — the first
 * `exit 1` is at line 15, nowhere near the staple logic. Anchoring on the block
 * is the whole point: a mutation aimed at an unrelated occurrence proves
 * nothing, and writing this helper naively is how the original gate's blind
 * spot reproduces itself in its own test.
 */
function indexInBlock(lines: string[], trimmed: string): number {
  const anchor = lines.findIndex(
    (line) => line.trim() === requiredMacStaplerFailureBlock[0],
  );
  if (anchor === -1) throw new Error("staple-failure block anchor not found");
  const limit = anchor + requiredMacStaplerFailureBlock.length;
  for (let index = anchor; index < limit && index < lines.length; index++) {
    if (lines[index].trim() === trimmed) return index;
  }
  throw new Error(
    `no line matching ${JSON.stringify(trimmed)} inside the block`,
  );
}

/** Drop the guarded block's copy of `trimmed`, preserving everything else. */
function deleteFirstLine(script: string, trimmed: string): string {
  const lines = script.split("\n");
  lines.splice(indexInBlock(lines, trimmed), 1);
  return lines.join("\n");
}

/** Swap the guarded block's copy of `trimmed` with the line after it. */
function swapWithNextLine(script: string, trimmed: string): string {
  const lines = script.split("\n");
  const index = indexInBlock(lines, trimmed);
  const [moved] = lines.splice(index, 1);
  lines.splice(index + 1, 0, moved);
  return lines.join("\n");
}

describe("macOS stager staple-failure gate", () => {
  it("passes on the unmodified stager", () => {
    expect(
      containsContiguousBlock(stager, requiredMacStaplerFailureBlock),
    ).toBe(true);
  });

  it("fails when the require-staple `exit 1` is deleted", () => {
    // The regression this gate exists to prevent: without it, a release that
    // REQUIRES a stapled DMG falls through to the warning and ships unstapled.
    const mutated = deleteFirstLine(stager, "exit 1");

    expect(
      containsContiguousBlock(mutated, requiredMacStaplerFailureBlock),
    ).toBe(false);
  });

  it("fails when two lines of the block are reordered without deleting any", () => {
    // Every line still exists, so any per-line presence check still passes.
    const mutated = swapWithNextLine(stager, "exit 1");

    expect(mutated.includes("exit 1")).toBe(true);
    expect(
      containsContiguousBlock(mutated, requiredMacStaplerFailureBlock),
    ).toBe(false);
  });

  it("fails when the block is split apart but every line survives", () => {
    const lines = stager.split("\n");
    lines.splice(
      indexInBlock(lines, "exit 1") + 1,
      0,
      '    echo "interposed" >&2',
    );
    const mutated = lines.join("\n");

    expect(
      containsContiguousBlock(mutated, requiredMacStaplerFailureBlock),
    ).toBe(false);
  });

  it("survives reindentation of the guarded block", () => {
    // Order and adjacency carry the contract; leading whitespace does not, so
    // reformatting must not turn the gate red.
    const lines = stager.split("\n");
    const index = indexInBlock(lines, "exit 1");
    lines[index] = `\t\t${lines[index].trim()}`;

    expect(
      containsContiguousBlock(lines.join("\n"), requiredMacStaplerFailureBlock),
    ).toBe(true);
  });

  it("demonstrates why per-line assertions cannot catch these mutations", () => {
    // This is the old gate's predicate. It is green on both mutations above —
    // which is precisely the defect, and why the block check has to exist.
    const perLinePasses = (script: string) =>
      requiredMacStaplerFailureBlock.every((line) =>
        script.includes(line.trim()),
      );

    expect(perLinePasses(deleteFirstLine(stager, "exit 1"))).toBe(true);
    expect(perLinePasses(swapWithNextLine(stager, "exit 1"))).toBe(true);
  });
});

describe("containsContiguousBlock", () => {
  it("requires the lines to be consecutive and ordered", () => {
    const content = "alpha\nbeta\ngamma";

    expect(containsContiguousBlock(content, ["alpha", "beta"])).toBe(true);
    expect(containsContiguousBlock(content, ["beta", "alpha"])).toBe(false);
    expect(containsContiguousBlock(content, ["alpha", "gamma"])).toBe(false);
  });

  it("matches a block that ends the content", () => {
    expect(containsContiguousBlock("alpha\nbeta", ["alpha", "beta"])).toBe(
      true,
    );
  });

  it("does not read past the end of the content", () => {
    expect(containsContiguousBlock("alpha", ["alpha", "beta"])).toBe(false);
  });

  it("treats an empty block as vacuously present", () => {
    expect(containsContiguousBlock("alpha", [])).toBe(true);
  });
});
