/** Proves emitted scripts execute under Node inside an installed package. */

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitScriptArtifacts } from "../emit-script-artifacts.ts";

test("emits runnable installed entrypoints and preserves source inputs", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "installed-script-artifacts-"),
  );
  try {
    const scripts = path.join(
      root,
      "node_modules",
      "fixture",
      "dist",
      "scripts",
    );
    mkdirSync(scripts, { recursive: true });
    writeFileSync(path.join(scripts, "package.json"), '{"type":"module"}');
    const source = "export const answer: number = 42;\n";
    writeFileSync(path.join(scripts, "answer.ts"), source);
    writeFileSync(
      path.join(scripts, "main.ts"),
      'import { answer } from "./answer.ts"; process.stdout.write(JSON.stringify({answer, unchanged: "unrelated.ts"}));\n',
    );
    expect(emitScriptArtifacts(scripts)).toHaveLength(2);
    const output = execFileSync("node", [path.join(scripts, "main.mjs")], {
      encoding: "utf8",
    });
    expect(JSON.parse(output)).toEqual({
      answer: 42,
      unchanged: "unrelated.ts",
    });
    expect(readFileSync(path.join(scripts, "answer.ts"), "utf8")).toBe(source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
