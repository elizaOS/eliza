/**
 * Guards the physical-device smoke's failure path: the catch in main() must
 * set the exit code rather than exit, so the finally block still removes the
 * temp Xcode project. The smoke itself needs a tethered iPhone, so this checks
 * the main() control flow in source.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  new URL("./run-physical-device-smoke.ts", import.meta.url),
  "utf8",
);

describe("run-physical-device-smoke failure cleanup", () => {
  it("does not exit the process from the catch that precedes temp cleanup", () => {
    const mainStart = source.indexOf("async function main()");
    expect(mainStart).toBeGreaterThan(-1);
    const main = source.slice(mainStart);
    const catchStart = main.lastIndexOf("} catch (err) {");
    const finallyStart = main.indexOf("} finally {", catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(finallyStart).toBeGreaterThan(catchStart);
    const catchBlock = main.slice(catchStart, finallyStart);
    expect(catchBlock).not.toMatch(/process\.exit\(/);
    expect(catchBlock).toMatch(/process\.exitCode\s*=/);
    expect(main.slice(finallyStart)).toMatch(
      /removeDirectoryRecursive\(tempDir\)/,
    );
  });
});
