/** Proves the scheduled soak accepts only a verified corpus and fixed repository targets. */

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSoakArgs,
  produceContentContextSoak,
} from "../run-content-context-soak.mjs";

describe("content-context soak producer", () => {
  it("requires a corpus root, output, and exact commit", () => {
    expect(() => parseSoakArgs([])).toThrow(/corpus-root is required/u);
    expect(
      parseSoakArgs([
        "--corpus-root=/private/corpus",
        "--out=/private/soak.json",
        `--commit=${"a".repeat(40)}`,
      ]),
    ).toEqual({
      corpusRoot: "/private/corpus",
      out: "/private/soak.json",
      commit: "a".repeat(40),
    });
  });

  it("rejects caller-selected factory modules", () => {
    expect(() =>
      parseSoakArgs([
        "--factory-module=/private/lookalike.mjs",
        "--corpus-root=/private/corpus",
        "--out=/private/soak.json",
        `--commit=${"a".repeat(40)}`,
      ]),
    ).toThrow(/unsupported soak argument/u);
  });

  it("fails before target creation when the corpus is not verified", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "content-soak-invalid-"),
    );
    try {
      await fs.writeFile(path.join(root, "manifest.json"), "{}\n", {
        mode: 0o600,
      });
      const output = path.join(root, "soak.json");
      await expect(
        produceContentContextSoak({
          corpusRoot: root,
          out: output,
          commit: "a".repeat(40),
        }),
      ).rejects.toThrow(/manifest|schema|invalid/u);
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await fs.readdir(root)).some((name) =>
          name.startsWith(".content-context-soak-"),
        ),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-exact commit before reading the corpus", async () => {
    await expect(
      produceContentContextSoak({
        corpusRoot: "/does/not/exist",
        out: "/does/not/matter",
        commit: "short",
      }),
    ).rejects.toMatchObject({ code: "SOAK_COMMIT_INVALID" });
  });
});
